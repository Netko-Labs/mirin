/**
 * Worker-side runtime: loads libmirin_core, starts the RPC server, and pumps
 * native events to feature modules. Infrastructure only — the developer-facing
 * API lives in app/index.ts and the feature modules, which subscribe here.
 */

import { join } from "node:path";
import { workerData } from "node:worker_threads";
import type { WindowConfig } from "./config/index.ts";
import { Core } from "./native.ts";
import { RpcServer } from "./rpc-server.ts";

export interface ManifestWindowConfig extends WindowConfig {
  name: string;
}

export interface Runtime {
  core: Core;
  rpc: RpcServer;
  manifestWindows: ManifestWindowConfig[];
  /** App bundle id (mirin.config `id`); undefined when detached. */
  id?: string;
  /** True under `mirin dev`; false in a packaged build. */
  isDev: boolean;
  devUrl?: string;
  /** Contents/Resources of the running .app (for the updater). Absent in dev. */
  resourcesDir?: string;
  /** Path to libmirin_core (for the updater codec). */
  corePath?: string;
  /** Dir holding bundled sidecar binaries (for `app.sidecar`). */
  sidecarDir?: string;
  /** Dir holding bundled extra-worker JS (for `resolveWorker`). */
  workersDir?: string;
}

export class NotAttachedError extends Error {
  constructor(what: string) {
    super(`${what}: the mirin native host is not attached. Run via \`mirin dev\`.`);
    this.name = "NotAttachedError";
  }
}

let current: Runtime | undefined;

/** The live runtime; throws if the native host isn't attached. */
export function runtime(): Runtime {
  if (!current) throw new NotAttachedError("mirin runtime");
  return current;
}

/** Dev: every window loads the Vite server. Production: its manifest app:// URL.
 *  Any query/hash on the requested URL (e.g. "#devtools") is preserved so
 *  hash-routed sub-windows reach the right view through the dev server too. */
export function resolveUrl(url: string): string {
  const devUrl = current?.devUrl;
  if (!devUrl) return url;
  const suffix = url.match(/[?#].*$/)?.[0] ?? "";
  return devUrl + suffix;
}

// ---- native event dispatch ----

export interface NativeEvent {
  type: string;
  [key: string]: unknown;
}

type NativeListener = (event: NativeEvent) => void;
const listeners = new Map<string, Set<NativeListener>>();

/** Subscribe to a native event type (e.g. "menu.click"). Safe before boot. */
export function onNativeEvent(type: string, listener: NativeListener): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

function dispatch(raw: string): void {
  let event: NativeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  for (const fn of listeners.get(event.type) ?? []) fn(event);
}

/** Boot the runtime from the Worker's workerData. No-op when run detached. */
export function boot(): void {
  const data = (workerData ?? {}) as {
    corePath?: string;
    manifest?: { windows?: Record<string, WindowConfig> };
    id?: string;
    devUrl?: string;
    resourcesDir?: string;
    sidecarDir?: string;
    workersDir?: string;
  };
  const corePath = data.corePath ?? process.env.MIRIN_CORE;
  if (!corePath) return; // not under the host; the API stays detached

  const core = new Core(corePath);
  const rpc = new RpcServer();
  const port = rpc.start();
  core.setRpcEndpoint(port, rpc.token);

  // Internal control actions from the preload bootstrap. `window.maybeStartDrag`
  // forwards a left-mousedown's viewport coords; native checks them against the
  // window's drag regions and begins an OS window-move if it's a title-bar drag
  // area (the webview consumes the event, so dragging is driven from the renderer).
  rpc.setControlHandler((frame, webview) => {
    switch (frame.action) {
      case "window.maybeStartDrag":
        core.windowMaybeStartDrag(
          webview,
          frame.x ?? 0,
          frame.y ?? 0,
          frame.detail ?? 1,
          frame.ht ?? 0,
        );
        break;
      case "window.control":
        if (frame.verb) core.windowControl(webview, frame.verb);
        break;
      case "window.close":
        core.windowClose(webview);
        break;
    }
  });

  const manifestWindows: ManifestWindowConfig[] = Object.entries(data.manifest?.windows ?? {}).map(
    ([name, cfg]) => ({ name, ...cfg }),
  );

  current = {
    core,
    rpc,
    manifestWindows,
    id: data.id,
    isDev: !!data.devUrl,
    devUrl: data.devUrl,
    resourcesDir: data.resourcesDir,
    corePath,
    sidecarDir: data.sidecarDir,
    workersDir: data.workersDir,
  };
  core.onEvent(dispatch);
}

/**
 * Resolve a bundled extra-worker (declared in `mirin.config.ts` `workers`) to an
 * absolute path, for `new Worker(resolveWorker(name))` from `node:worker_threads`.
 * Works in `mirin dev` and the built `.app`. Extra workers run off the main
 * thread and must not call window/native APIs.
 */
export function resolveWorker(name: string): string {
  const dir = current?.workersDir;
  if (!dir) throw new NotAttachedError("resolveWorker");
  return join(dir, `${name}.js`);
}
