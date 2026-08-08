/**
 * RPC data plane (docs/architecture.md §4): a token-authenticated localhost
 * WebSocket the injected `window.mirin` connects to. Requests dispatch to the
 * app's router here, in the Bun Worker; events push back to webviews.
 */

import type { ServerWebSocket } from "bun";
import { devtoolsOptions } from "./devtools/options.ts";
import { record } from "./devtools/sink.ts";
import type { Procedure, Router, RpcContext } from "./rpc.ts";
import { formatArg } from "./shared/format.ts";

interface SocketData {
  webview: number;
}

interface RequestFrame {
  kind: "request";
  id: number;
  method: string;
  input: unknown;
}

/** Internal control frame from the preload bootstrap (window dragging, etc.) —
 *  a side channel distinct from the app's typed RPC. `x`/`y` are viewport pixels
 *  (CSS px, top-left) for pointer-driven actions like drag detection. */
interface ControlFrame {
  kind: "control";
  action: string;
  x?: number;
  y?: number;
  verb?: string;
  /** Click count for pointer actions (2 = double-click → maximize). */
  detail?: number;
  /** Win32 resize hit-test code when the mousedown is on a window edge/corner. */
  ht?: number;
}

type IncomingFrame = RequestFrame | ControlFrame;

/** Handles an internal control action for the webview that sent it. */
export type ControlHandler = (frame: ControlFrame, webview: number) => void;

export class RpcServer {
  readonly token = crypto.randomUUID();
  #server?: ReturnType<typeof Bun.serve>;
  // Type-level `any` keeps the server able to store any concrete app router.
  #router?: Router<any>;
  #control?: ControlHandler;
  #sockets = new Set<ServerWebSocket<SocketData>>();

  /** Start listening on an ephemeral loopback port; returns the bound port. */
  start(): number {
    const token = this.token;
    const onMessage = (ws: ServerWebSocket<SocketData>, raw: string | Buffer) =>
      this.#onMessage(ws, raw);
    const sockets = this.#sockets;

    const server = Bun.serve<SocketData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.searchParams.get("token") !== token) {
          return new Response("unauthorized", { status: 401 });
        }
        const webview = Number(url.searchParams.get("webview") ?? "0");
        if (server.upgrade(req, { data: { webview } })) return undefined;
        return new Response("mirin rpc");
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
        },
        message(ws, message) {
          onMessage(ws, message);
        },
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    this.#server = server;
    const port = server.port;
    if (port == null) throw new Error("mirin rpc server failed to bind a port");
    return port;
  }

  /** Stop accepting connections and close active webview sockets. */
  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;

    this.#server = undefined;
    this.#sockets.clear();
    await server.stop(true);
  }

  /** Type-level `any` keeps the caller's concrete router shape. */
  setRouter(router: Router<any>): void {
    this.#router = router;
  }

  /** The registered procedures, for the inspector's `/state`: a tool can discover
   *  the RPC surface without reading source. */
  routes(): { name: string; type: string }[] {
    const routes: Record<string, Procedure> = this.#router?.routes ?? {};
    return Object.entries(routes).map(([name, proc]) => ({ name, type: proc.type }));
  }

  /** Register the handler for internal `mirin:*` control actions (e.g. window drag). */
  setControlHandler(handler: ControlHandler): void {
    this.#control = handler;
  }

  /** Push an event to every connected webview. */
  broadcast(method: string, payload: unknown): void {
    const frame = JSON.stringify({ kind: "event", method, payload });
    for (const ws of this.#sockets) ws.send(frame);
  }

  /** Push an event to a single webview. */
  emitTo(webview: number, method: string, payload: unknown): void {
    const frame = JSON.stringify({ kind: "event", method, payload });
    for (const ws of this.#sockets) {
      if (ws.data.webview === webview) ws.send(frame);
    }
  }

  async #onMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
    let frame: IncomingFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    // Internal control side channel (window drag, …) from the preload bootstrap.
    if (frame.kind === "control") {
      traceControl(frame, ws.data.webview);
      this.#control?.(frame, ws.data.webview);
      return;
    }
    if (frame.kind !== "request") return;

    const reply = (ok: boolean, body: { result?: unknown; error?: string }) =>
      ws.send(JSON.stringify({ kind: "response", id: frame.id, ok, ...body }));

    const webview = ws.data.webview;
    traceRequest(frame, webview);

    const proc = this.#router?.routes[frame.method];
    if (!proc || (proc.type !== "query" && proc.type !== "mutation")) {
      const error = `no such procedure: ${frame.method}`;
      traceFailure(frame, webview, 0, error, "unknown-procedure");
      reply(false, { error });
      return;
    }

    const ctx: RpcContext = { webview };
    const startedAt = performance.now();
    try {
      const result = await proc.handler(frame.input, ctx);
      traceSuccess(frame, webview, performance.now() - startedAt, proc.type, result);
      reply(true, { result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      traceFailure(frame, webview, performance.now() - startedAt, error, proc.type, err);
      reply(false, { error });
    }
  }
}

/** Round to a tenth of a millisecond — enough to spot a slow handler. */
function millis(elapsed: number): number {
  return Math.round(elapsed * 10) / 10;
}

// Payloads stay out of the trace unless `devtools.rpcPayloads` is set: they carry
// app data and the stream is written to disk in plain text.
function payload(value: unknown): Record<string, unknown> {
  return devtoolsOptions().rpcPayloads ? { payload: formatArg(value) } : {};
}

function traceRequest(frame: RequestFrame, webview: number): void {
  record({
    src: "rpc",
    level: "debug",
    type: "rpc.request",
    msg: `→ ${frame.method}`,
    window: webview,
    data: { id: frame.id, method: frame.method, ...payload(frame.input) },
  });
}

function traceSuccess(
  frame: RequestFrame,
  webview: number,
  elapsed: number,
  kind: string,
  result: unknown,
): void {
  record({
    src: "rpc",
    level: "debug",
    type: "rpc.response",
    msg: `← ${frame.method} ok in ${millis(elapsed)}ms`,
    window: webview,
    data: {
      id: frame.id,
      method: frame.method,
      kind,
      ok: true,
      ms: millis(elapsed),
      ...payload(result),
    },
  });
}

function traceFailure(
  frame: RequestFrame,
  webview: number,
  elapsed: number,
  error: string,
  kind: string,
  thrown?: unknown,
): void {
  record({
    src: "rpc",
    level: "error",
    type: "rpc.error",
    msg: `← ${frame.method} failed: ${error}`,
    window: webview,
    data: {
      id: frame.id,
      method: frame.method,
      kind,
      ok: false,
      ms: millis(elapsed),
      error,
      ...(thrown instanceof Error && thrown.stack !== undefined
        ? {
            stack: thrown.stack
              .split("\n")
              .slice(0, 12)
              .map((line) => line.trim()),
          }
        : {}),
    },
  });
}

/** Pointer plumbing (`window.maybeStartDrag` fires on every mousedown) carries no
 *  diagnostic value and would evict useful events, so only real intent is traced. */
function traceControl(frame: ControlFrame, webview: number): void {
  if (frame.action === "window.maybeStartDrag") return;
  record({
    src: "rpc",
    level: "debug",
    type: "rpc.control",
    msg: `⇢ ${frame.action}${frame.verb !== undefined ? ` ${frame.verb}` : ""}`,
    window: webview,
    data: { action: frame.action, ...(frame.verb !== undefined ? { verb: frame.verb } : {}) },
  });
}
