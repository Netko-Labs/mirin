/**
 * The `app` singleton, window handles, and typed event emitters
 * (docs/api-design.md). Talks to the native core through the runtime.
 */

import { runtime, onNativeEvent, resolveUrl, type NativeEvent } from "./runtime.ts";
import type { Router, EventProc } from "./rpc.ts";
import type { WindowConfig, WindowMaterial, WindowMaterialOptions } from "./config.ts";

/** Which native backend a window's `material` resolved to. */
export type WindowMaterialInfo = {
  /** The material that was requested. */
  requested: string;
  /** What actually rendered: real Liquid Glass, a vibrancy material, or none. */
  backend: "liquidGlass" | "vibrancy" | "none";
  /** Whether Apple's Liquid Glass (NSGlassEffectView, macOS 26+) is available. */
  liquidGlassAvailable: boolean;
};

export type WindowEvents = {
  focus: void;
  blur: void;
  moved: void;
  resized: void;
  closed: void;
  /** Fired when a native background material is applied (see setMaterial). */
  material: WindowMaterialInfo;
};

export type AppEvents = {
  ready: void;
  "window-all-closed": void;
};

type Listener<P> = (payload: P) => void;

class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener as Listener<unknown>);
    return () => set!.delete(listener as Listener<unknown>);
  }

  async *events<K extends keyof Events>(type: K): AsyncIterableIterator<Events[K]> {
    const queue: Events[K][] = [];
    let wake: (() => void) | undefined;
    const off = this.on(type, (payload) => {
      queue.push(payload);
      wake?.();
    });
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      off();
    }
  }

  protected emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.#listeners.get(type)?.forEach((fn) => fn(payload));
  }
}

export interface WindowOpenOptions extends WindowConfig {
  name?: string;
}

/** A live, typed handle to an open window. */
export class WindowHandle extends Emitter<WindowEvents> {
  constructor(
    readonly id: number,
    readonly name: string | undefined,
  ) {
    super();
  }

  async setTitle(title: string): Promise<void> {
    runtime().core.windowSetTitle(this.id, title);
  }

  async loadUrl(url: string): Promise<void> {
    runtime().core.windowLoadUrl(this.id, url);
  }

  async close(): Promise<void> {
    runtime().core.windowClose(this.id);
  }

  async minimize(): Promise<void> {
    this.#control("minimize");
  }
  async maximize(): Promise<void> {
    this.#control("maximize");
  }
  async restore(): Promise<void> {
    this.#control("restore");
  }
  async toggleFullscreen(): Promise<void> {
    this.#control("fullscreen");
  }
  async focus(): Promise<void> {
    this.#control("focus");
  }
  async show(): Promise<void> {
    this.#control("show");
  }
  async hide(): Promise<void> {
    this.#control("hide");
  }
  async center(): Promise<void> {
    this.#control("center");
  }
  async setAlwaysOnTop(on: boolean): Promise<void> {
    this.#control(on ? "alwaysOnTop:on" : "alwaysOnTop:off");
  }

  /**
   * Change the window's native background material live (macOS, transparent
   * windows only). Pass `null` to remove it. See {@link WindowMaterial}.
   */
  async setMaterial(material: WindowMaterial | WindowMaterialOptions | null): Promise<void> {
    runtime().core.windowSetMaterial(this.id, JSON.stringify(normalizeMaterial(material)));
  }

  #control(verb: string): void {
    runtime().core.windowControl(this.id, verb);
  }

  /** Typed push to this window's webview (used by router event procedures). */
  get rpc(): RpcEmitters {
    return rpcEmitters((method, payload) => runtime().rpc.emitTo(this.id, method, payload));
  }

  /** @internal */
  _emit<K extends keyof WindowEvents>(type: K, payload: WindowEvents[K]): void {
    this.emit(type, payload);
  }
}

type RpcEmitters = Record<string, { emit(payload: unknown): void; broadcast(payload: unknown): void }>;

function rpcEmitters(send: (method: string, payload: unknown) => void): RpcEmitters {
  return new Proxy({} as RpcEmitters, {
    get(_t, method: string) {
      return {
        emit: (payload: unknown) => send(method, payload),
        broadcast: (payload: unknown) => send(method, payload),
      };
    },
  });
}

/** Typed push emitters derived from a router's `event` procedures. */
export type BroadcastEmitters<R extends Router<any>> =
  R extends Router<infer T>
    ? {
        [K in keyof T as T[K] extends EventProc<any> ? K : never]: T[K] extends EventProc<infer P>
          ? { broadcast(payload: P): void }
          : never;
      }
    : never;

export interface ServeHandle<R extends Router<any>> {
  readonly rpc: BroadcastEmitters<R>;
}

class Windows {
  #byName = new Map<string, WindowHandle>();
  #byId = new Map<number, WindowHandle>();

  get(name: string): WindowHandle {
    const win = this.#byName.get(name);
    if (!win) throw new Error(`no window named "${name}" is open`);
    return win;
  }

  all(): WindowHandle[] {
    return [...this.#byId.values()];
  }

  /** Look up a window by its numeric id (e.g. an RPC ctx.webview). */
  byId(id: number): WindowHandle | undefined {
    return this.#byId.get(id);
  }

  async open(options: WindowOpenOptions | string): Promise<WindowHandle> {
    const opts = typeof options === "string" ? manifestWindow(options) : options;
    const id = runtime().core.windowCreate(
      JSON.stringify({
        ...opts,
        url: resolveUrl(opts.url),
        material: normalizeMaterial(opts.material),
      }),
    );
    const handle = new WindowHandle(id, opts.name);
    this.#register(handle);
    return handle;
  }

  #register(handle: WindowHandle): void {
    this.#byId.set(handle.id, handle);
    if (handle.name) this.#byName.set(handle.name, handle);
  }

  /** @internal */
  _byId(id: number): WindowHandle | undefined {
    return this.#byId.get(id);
  }
  /** @internal */
  _remove(id: number): void {
    const handle = this.#byId.get(id);
    if (handle) {
      this.#byId.delete(id);
      if (handle.name) this.#byName.delete(handle.name);
    }
  }
}

function manifestWindow(name: string): WindowOpenOptions {
  const found = runtime().manifestWindows.find((w) => w.name === name);
  if (!found) throw new Error(`no window "${name}" declared in the manifest`);
  return found;
}

/** Normalize the `material` option (name or object, or null) to native form. */
function normalizeMaterial(
  material: WindowMaterial | WindowMaterialOptions | null | undefined,
): WindowMaterialOptions | null {
  if (!material) return null;
  return typeof material === "string" ? { type: material } : material;
}

class MirinApp extends Emitter<AppEvents> {
  readonly windows = new Windows();

  serve<R extends Router<any>>(router: R): ServeHandle<R> {
    runtime().rpc.setRouter(router);
    return { rpc: this.rpc as BroadcastEmitters<R> };
  }

  get rpc(): RpcEmitters {
    return rpcEmitters((method, payload) => runtime().rpc.broadcast(method, payload));
  }

  quit(): void {
    runtime().core.quit();
  }

  /** @internal */
  _emit<K extends keyof AppEvents>(type: K, payload: AppEvents[K]): void {
    this.emit(type, payload);
  }
}

export const app = new MirinApp();

// ---- wire native events to the app/window emitters ----

const WINDOW_EVENTS = ["focus", "blur", "moved", "resized"] as const;

export function wireAppEvents(): void {
  onNativeEvent("core.ready", () => {
    for (const cfg of runtime().manifestWindows) {
      if (cfg.open === "manual") continue;
      void app.windows.open(cfg as WindowOpenOptions);
    }
    app._emit("ready", undefined);
  });

  onNativeEvent("window.closed", (event: NativeEvent) => {
    const id = event.id as number | undefined;
    if (id == null) return;
    app.windows._byId(id)?._emit("closed", undefined);
    app.windows._remove(id);
  });

  onNativeEvent("window.all-closed", () => app._emit("window-all-closed", undefined));

  onNativeEvent("window.material", (event: NativeEvent) => {
    const id = event.id as number | undefined;
    if (id == null) return;
    app.windows._byId(id)?._emit("material", {
      requested: String(event.requested ?? ""),
      backend: (event.backend as WindowMaterialInfo["backend"]) ?? "none",
      liquidGlassAvailable: Boolean(event.liquidGlassAvailable),
    });
  });

  for (const kind of WINDOW_EVENTS) {
    onNativeEvent(`window.${kind}`, (event: NativeEvent) => {
      const id = event.id as number | undefined;
      if (id != null) app.windows._byId(id)?._emit(kind, undefined);
    });
  }
}
