/**
 * mirin/client — the browser-side RPC client (docs/api-design.md §3).
 *
 * Runs inside webviews. Talks to the `window.mirin` transport installed by the
 * preload bootstrap (token-authenticated WebSocket to the Bun Worker — M3).
 */

import type { EventProc, MutationProc, QueryProc, Router } from "./rpc.ts";
import { SEPARATOR } from "./shared/rpc-paths.ts";

// Type-level `any` preserves the app router's concrete procedure inference for UI callers.
export type ClientFor<R extends Router<any>> = R extends Router<infer T>
  ? {
      [K in keyof T]: T[K] extends QueryProc<infer I, infer O>
        ? (input: I) => Promise<Awaited<O>>
        : T[K] extends MutationProc<infer I, infer O>
          ? (input: I) => Promise<Awaited<O>>
          : T[K] extends EventProc<infer P>
            ? { on(listener: (payload: P) => void): () => void }
            : T[K] extends Router<any>
              ? ClientFor<T[K]>
              : never;
    }
  : never;

interface MirinTransport {
  call(method: string, input: unknown): Promise<unknown>;
  onEvent(method: string, listener: (payload: unknown) => void): () => void;
  /** Fire-and-forget internal control action (window dragging/controls). */
  control?(action: string, extra?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    /** Installed by the mirin preload bootstrap before page scripts run. */
    mirin?: MirinTransport;
  }
}

function transport(): MirinTransport {
  const t = window.mirin;
  if (!t) {
    throw new Error(
      "window.mirin is not available — this page is not running inside a mirin webview " +
        "(or the preload bootstrap failed to authenticate).",
    );
  }
  return t;
}

/**
 * Create the typed client for the app's router. Pass the Router *type* only —
 * never import the router value (and its handlers) into UI code.
 */
// Type-level `any` keeps `client<AppRouter>()` inference intact.
export function client<R extends Router<any>>(): ClientFor<R> {
  const nodes = new Map<string, unknown>();
  const node = (path: string): unknown => {
    let found = nodes.get(path);
    if (found === undefined) {
      found = clientNode(path, node);
      nodes.set(path, found);
    }
    return found;
  };
  return new Proxy({} as ClientFor<R>, {
    get(_target, prop) {
      return typeof prop === "string" ? node(prop) : undefined;
    },
  });
}

/** What a function's caller expects to find on it; anything else is a nested name. */
const FUNCTION_MEMBERS = new Set(["apply", "bind", "call", "toString"]);

/**
 * One name in the client, `path` from the root. Procedure kind is unknowable
 * from the type-erased proxy, so it is all of them at once: callable (a query
 * or mutation), event-shaped (`.on`), and a router (any other name is a child
 * at `path.name`). The router type makes misuse a compile error, and
 * rpc.router keeps nested routers off the names used here.
 */
function clientNode(path: string, node: (path: string) => unknown): unknown {
  const call = (input: unknown) => transport().call(path, input);
  const on = (listener: (payload: unknown) => void) => transport().onEvent(path, listener);
  return new Proxy(call, {
    get(target, prop, receiver) {
      if (prop === "on") return on;
      // Not a promise: `await` and promise helpers must not take a node for one.
      if (prop === "then") return undefined;
      if (typeof prop !== "string" || FUNCTION_MEMBERS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return node(`${path}${SEPARATOR}${prop}`);
    },
  });
}

/**
 * Window controls for the current webview's window, callable from page code —
 * for custom title bars (`titleBarStyle: hidden | hiddenInset`) where the app
 * draws its own min/max/close buttons. On Windows these are the only controls
 * (no native caption); on macOS the native traffic lights usually serve instead.
 */
export const windowControls = {
  minimize(): void {
    transport().control?.("window.control", { verb: "minimize" });
  },
  maximize(): void {
    transport().control?.("window.control", { verb: "maximize" });
  },
  close(): void {
    transport().control?.("window.close");
  },
};
