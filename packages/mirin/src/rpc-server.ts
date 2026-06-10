/**
 * RPC data plane (docs/architecture.md §4): a token-authenticated localhost
 * WebSocket the injected `window.mirin` connects to. Requests dispatch to the
 * app's router here, in the Bun Worker; events push back to webviews.
 */

import type { Router, RpcContext } from "./rpc.ts";
import type { ServerWebSocket } from "bun";

interface SocketData {
  webview: number;
}

interface RequestFrame {
  kind: "request";
  id: number;
  method: string;
  input: unknown;
}

export class RpcServer {
  readonly token = crypto.randomUUID();
  #server?: ReturnType<typeof Bun.serve>;
  #router?: Router<any>;
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

  setRouter(router: Router<any>): void {
    this.#router = router;
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
    let frame: RequestFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
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
