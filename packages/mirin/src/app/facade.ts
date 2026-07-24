/**
 * The `app` singleton, window handles, and typed event emitters
 * (docs/api-design.md). Talks to the native core through the runtime.
 */

import type { WindowMaterial, WindowMaterialOptions } from "../config/index.ts";
import type { Router } from "../rpc.ts";
import {
  type NativeEvent,
  onNativeEvent,
  resolveUrl,
  runtime,
  signalUpdaterReady,
} from "../runtime.ts";
import type { SidecarOptions, SidecarProcess } from "../sidecar.ts";
import { sidecar as spawnSidecar } from "../sidecar.ts";
import type { Updater } from "../updater/index.ts";
import { updater } from "../updater/index.ts";
import { Emitter } from "./lib/emitter.ts";
import { normalizeMaterial } from "./lib/material.ts";
import type {
  AppEvents,
  BroadcastEmitters,
  Dock,
  ServeHandle,
  WindowEvents,
  WindowFrame,
  WindowMaterialInfo,
  WindowOpenOptions,
} from "./types.ts";

/** A live, typed handle to an open window. */
export class WindowHandle extends Emitter<WindowEvents> {
  readonly id: number;
  readonly name: string | undefined;

  constructor(id: number, name: string | undefined) {
    super();
    this.id = id;
    this.name = name;
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

  /** Move the window's bottom-left origin to screen point (x, y), in points. */
  setPosition(x: number, y: number): void {
    runtime().core.windowSetPosition(this.id, x, y);
  }

  /** The latest known window frame (screen points, bottom-left origin). Tracked
   *  from `moved`/`resized` events, so it's current without a round-trip. */
  getFrame(): WindowFrame {
    return this.#frame ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  /** Whether the window is currently zoomed (maximized). */
  isMaximized(): boolean {
    return this.#maximized;
  }

  #frame: WindowFrame | null = null;
  #maximized = false;

  /** @internal — fed from native window frame events. */
  _setFrame(frame: WindowFrame, maximized: boolean): void {
    this.#frame = frame;
    this.#maximized = maximized;
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

type RpcEmitters = Record<
  string,
  { emit(payload: unknown): void; broadcast(payload: unknown): void }
>;

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

class MirinApp extends Emitter<AppEvents> {
  readonly windows = new Windows();

  /** Cross-platform auto-updater. Inert unless the app was built with `release` set. */
  readonly updater: Updater = updater;

  /** This app's bundle id (mirin.config `id`). `undefined` when run detached. */
  get id(): string | undefined {
    try {
      return runtime().id;
    } catch {
      return undefined;
    }
  }

  /** True under `mirin dev`; false in a packaged build (and when detached). Use it
   *  to keep dev and installed data (caches, databases) separate. */
  get isDev(): boolean {
    try {
      return runtime().isDev;
    } catch {
      return false;
    }
  }

  /** macOS Dock-icon controls. Hiding suits resident, hotkey-summoned apps. */
  readonly dock: Dock = {
    hide: () => this.#setDock(false),
    show: () => this.#setDock(true),
  };

  /** Apply the Dock policy now if the core is up, else once it's ready. The
   *  native command needs the CEF UI thread, which only runs after `ready`. */
  #setDock(visible: boolean): void {
    const apply = () => runtime().core.appSetDockVisible(visible);
    if (runtime().core.isReady()) {
      apply();
    } else {
      const off = this.on("ready", () => {
        off();
        apply();
      });
    }
  }

  /** Type-level `any` preserves the caller's concrete router shape. */
  serve<R extends Router<any>>(router: R): ServeHandle<R> {
    runtime().rpc.setRouter(router);
    return { rpc: this.rpc as BroadcastEmitters<R> };
  }

  get rpc(): RpcEmitters {
    return rpcEmitters((method, payload) => runtime().rpc.broadcast(method, payload));
  }

  /**
   * Spawn a bundled sidecar binary (declared in `mirin.config.ts` `sidecars`).
   * Resolves the in-bundle path and tracks the child so it's killed on quit.
   */
  sidecar(name: string, opts?: SidecarOptions): SidecarProcess {
    return spawnSidecar(name, opts);
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
    signalUpdaterReady();
  });

  onNativeEvent("window.closed", (event: NativeEvent) => {
    const id = event.id as number | undefined;
    if (id == null) return;
    app.windows._byId(id)?._emit("closed", undefined);
    app.windows._remove(id);
  });

  onNativeEvent("window.all-closed", () => app._emit("window-all-closed", undefined));

  onNativeEvent("app.open-url", (event: NativeEvent) => {
    const url = event.url;
    if (typeof url === "string") app._emit("open-url", url);
  });

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
      if (id == null) return;
      const handle = app.windows._byId(id);
      if (!handle) return;
      // moved/resized carry the current frame + maximized state; track them so
      // getFrame()/isMaximized() are answerable without a round-trip.
      if (event.frame) {
        handle._setFrame(event.frame as WindowFrame, Boolean(event.maximized));
      }
      handle._emit(kind, undefined);
    });
  }
}
