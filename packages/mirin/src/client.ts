/**
 * mirin/client — the browser-side RPC client (docs/api-design.md §3).
 *
 * Runs inside webviews. Talks to the `window.mirin` transport installed by the
 * preload bootstrap (token-authenticated WebSocket to the Bun Worker — M3).
 */

import type { EventProc, MutationProc, QueryProc, Router } from "./rpc.ts";

export type ClientFor<R extends Router<any>> =
  R extends Router<infer T>
    ? {
        [K in keyof T]: T[K] extends QueryProc<infer I, infer O>
          ? (input: I) => Promise<Awaited<O>>
          : T[K] extends MutationProc<infer I, infer O>
            ? (input: I) => Promise<Awaited<O>>
            : T[K] extends EventProc<infer P>
              ? { on(listener: (payload: P) => void): () => void }
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
export function client<R extends Router<any>>(): ClientFor<R> {
  const eventCache = new Map<string, { on(l: (p: unknown) => void): () => void }>();

  return new Proxy({} as ClientFor<R>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      // Procedure kind is unknowable from the type-erased proxy; expose a callable
      // that is *also* event-shaped. The router type makes misuse a compile error.
      const callable = (input: unknown) => transport().call(prop, input);
      let ev = eventCache.get(prop);
      if (!ev) {
        ev = { on: (listener) => transport().onEvent(prop, listener) };
        eventCache.set(prop, ev);
      }
      return Object.assign(callable, ev);
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
