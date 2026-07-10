/**
 * mirin/rpc — schema-derived typed RPC (docs/api-design.md §3).
 *
 * Imported by BOTH the main process (handlers run here, in the Bun Worker)
 * and UI code (type-only, via `client<Router>()` from mirin/client).
 * The router is global; handlers learn their caller from `ctx`.
 */

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

export interface Router<T extends Record<string, Procedure> = Record<string, Procedure>> {
  readonly type: "router";
  readonly routes: T;
}

export const rpc = {
  router<T extends Record<string, Procedure>>(routes: T): Router<T> {
    return { type: "router", routes };
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
