/**
 * RPC data plane (docs/architecture.md §4): a token-authenticated localhost
 * WebSocket the injected `window.mirin` connects to. Requests dispatch to the
 * app's router here, in the Bun Worker; events push back to webviews.
 */

import type { ServerWebSocket } from "bun";
import type { Router, RpcContext } from "./rpc.ts";

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
        // The webview id is assigned by the native core and injected into each
        // webview's preload; reject a malformed value rather than coercing it.
        const webview = Number(url.searchParams.get("webview") ?? "0");
        if (!Number.isInteger(webview) || webview < 0) {
          return new Response("bad webview", { status: 400 });
        }
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

  /** Register the handler for internal `mirin:*` control actions (e.g. window drag). */
  setControlHandler(handler: ControlHandler): void {
    this.#control = handler;
  }

  /** Push an event to every connected webview. */
  broadcast(method: string, payload: unknown): void {
    const frame = JSON.stringify({ kind: "event", method, payload });
    for (const ws of this.#sockets) this.#send(ws, frame);
  }

  /** Push an event to a single webview. */
  emitTo(webview: number, method: string, payload: unknown): void {
    const frame = JSON.stringify({ kind: "event", method, payload });
    for (const ws of this.#sockets) {
      if (ws.data.webview === webview) this.#send(ws, frame);
    }
  }

  /** Send to one socket, tolerating a socket that is mid-close — one dead
   *  webview must not abort delivery to the rest of the fan-out. */
  #send(ws: ServerWebSocket<SocketData>, frame: string): void {
    try {
      ws.send(frame);
    } catch {
      // socket closing/closed; drop this delivery
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
      this.#control?.(frame, ws.data.webview);
      return;
    }
    if (frame.kind !== "request") return;

    const reply = (ok: boolean, body: { result?: unknown; error?: string }) =>
      ws.send(JSON.stringify({ kind: "response", id: frame.id, ok, ...body }));

    const proc = this.#router?.routes[frame.method];
    if (!proc || (proc.type !== "query" && proc.type !== "mutation")) {
      reply(false, { error: `no such procedure: ${frame.method}` });
      return;
    }

    const ctx: RpcContext = { webview: ws.data.webview };
    try {
      const result = await proc.handler(frame.input, ctx);
      reply(true, { result });
    } catch (err) {
      reply(false, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
