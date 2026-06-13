/**
 * Worker-side runtime: loads libmirin_core, starts the RPC server, and pumps
 * native events to feature modules. Infrastructure only — the developer-facing
 * API lives in app.ts and the feature modules, which subscribe here.
 */

import { workerData } from "node:worker_threads";
import { Core } from "./native.ts";
import { RpcServer } from "./rpc-server.ts";
import type { WindowConfig } from "./config.ts";

export interface ManifestWindowConfig extends WindowConfig {
  name: string;
}

export interface Runtime {
  core: Core;
  rpc: RpcServer;
  manifestWindows: ManifestWindowConfig[];
  devUrl?: string;
  /** Contents/Resources of the running .app (for the updater). Absent in dev. */
  resourcesDir?: string;
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
  if (!set) listeners.set(type, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}

function dispatch(raw: string): void {
  let event: NativeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  listeners.get(event.type)?.forEach((fn) => fn(event));
}

/** Boot the runtime from the Worker's workerData. No-op when run detached. */
export function boot(): void {
  const data = (workerData ?? {}) as {
    corePath?: string;
    manifest?: { windows?: Record<string, WindowConfig> };
    devUrl?: string;
    resourcesDir?: string;
  };
  const corePath = data.corePath ?? process.env.MIRIN_CORE;
  if (!corePath) return; // not under the host; the API stays detached

  const core = new Core(corePath);
  const rpc = new RpcServer();
  const port = rpc.start();
  core.setRpcEndpoint(port, rpc.token);

  const manifestWindows: ManifestWindowConfig[] = Object.entries(
    data.manifest?.windows ?? {},
  ).map(([name, cfg]) => ({ name, ...cfg }));

  current = { core, rpc, manifestWindows, devUrl: data.devUrl, resourcesDir: data.resourcesDir };
  core.onEvent(dispatch);
}
