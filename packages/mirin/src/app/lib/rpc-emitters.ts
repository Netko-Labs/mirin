/**
 * The untyped emitters behind `app.rpc` and a window's `rpc`: `rpc.progress`
 * sends the event `progress`, and `rpc.window.focused` the nested router's
 * `window.focused` (docs/api-design.md §3). `app.serve` hands out the same
 * object typed by the router (BroadcastEmitters).
 */

import { SEPARATOR } from "../../shared/rpc-paths.ts";

/** An event by name, and the events of a nested router under it (`rpc.window.focused`). */
export type RpcEmitter = {
  emit(payload: unknown): void;
  broadcast(payload: unknown): void;
} & RpcEmitters;

export interface RpcEmitters {
  readonly [name: string]: RpcEmitter;
}

export function rpcEmitters(send: (method: string, payload: unknown) => void): RpcEmitters {
  const node = (method: string): RpcEmitter =>
    new Proxy({} as RpcEmitter, {
      get(_t, prop) {
        if (prop === "emit" || prop === "broadcast") {
          return (payload: unknown) => send(method, payload);
        }
        // Not a promise, and nothing behind symbols.
        if (typeof prop !== "string" || prop === "then") return undefined;
        return node(`${method}${SEPARATOR}${prop}`);
      },
    });
  return new Proxy({} as RpcEmitters, {
    get(_t, method) {
      return typeof method === "string" ? node(method) : undefined;
    },
  });
}
