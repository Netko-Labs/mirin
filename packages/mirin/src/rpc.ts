/**
 * mirin/rpc — schema-derived typed RPC (docs/api-design.md §3).
 *
 * Imported by BOTH the main process (handlers run here, in the Bun Worker)
 * and UI code (type-only, via `client<Router>()` from mirin/client).
 * The router is global; handlers learn their caller from `ctx`. Routers nest:
 * a router's routes can be other routers, and their procedures are called by
 * path (`api.window.min()`, `window.min` on the wire).
 */

import { procedures } from "./shared/rpc-paths.ts";

export interface RpcContext {
  /** Name of the calling window, if it was opened with one. */
  window?: string;
  /** Numeric id of the calling webview. */
  webview: number;
}

export type Handler<I, O> = (input: I, ctx: RpcContext) => O | Promise<O>;

export interface QueryProc<I, O> {
  readonly type: "query";
  readonly handler: Handler<I, O>;
}

export interface MutationProc<I, O> {
  readonly type: "mutation";
  readonly handler: Handler<I, O>;
}

export interface EventProc<P> {
  readonly type: "event";
  /** Phantom field carrying the payload type; never set at runtime. */
  readonly payload?: P;
}

// Type-level `any` preserves caller-defined handler input/output inference here;
// no runtime value is widened through this union.
export type Procedure = QueryProc<any, any> | MutationProc<any, any> | EventProc<any>;

/** What a router holds: procedures, and other routers under their own names. */
export interface Routes {
  // Type-level `any` keeps each nested router's own procedure types.
  readonly [name: string]: Procedure | Router<any>;
}

export interface Router<T extends Routes = Routes> {
  readonly type: "router";
  readonly routes: T;
}

export const rpc = {
  /**
   * Define a router. Nested routers keep their procedures apart
   * (`window.close` and `install.close` are two procedures). Throws when two
   * procedures end up with the same path, or when a nested router uses a name
   * the client needs (`on`, `then`, `emit`, `broadcast`, `apply`, `bind`,
   * `call`, `toString`).
   */
  router<T extends Routes>(routes: T): Router<T> {
    const router: Router<T> = { type: "router", routes };
    procedures(router);
    return router;
  },

  /** Request/response, semantically a read. Runtime-identical to mutation in the MVP. */
  query<I, O>(handler: Handler<I, O>): QueryProc<I, O> {
    return { type: "query", handler };
  },

  /** Request/response, semantically a write. */
  mutation<I, O>(handler: Handler<I, O>): MutationProc<I, O> {
    return { type: "mutation", handler };
  },

  /** Main → UI push channel. Emit via window handles or app.rpc broadcast. */
  event<P>(): EventProc<P> {
    return { type: "event" };
  },
};
