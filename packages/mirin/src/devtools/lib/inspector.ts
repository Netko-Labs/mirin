/**
 * The inspector: a token-authenticated loopback HTTP server (docs/agent-devtools.md).
 * Runs in the Bun Worker; port and token are published to
 * `.mirin/dev/<session>/inspector.json`.
 *
 *   GET  /                 route index
 *   GET  /health           liveness, pid, stream cursor
 *   GET  /state            windows, RPC routes, exposed app state
 *   GET  /logs             the structured event stream, filterable
 *   GET  /logs/stream      the same as Server-Sent Events, with replay
 */

import { devtoolsOptions } from "../options.ts";
import { sink } from "../sink.ts";
import type { DevEvent } from "../types.ts";
import { json, jsonError, rejectUnauthorized } from "./http.ts";
import { matches, parseQuery } from "./query.ts";
import { stateSnapshot } from "./state.ts";

/** Keepalive cadence for SSE, so an idle stream is not mistaken for a dead one. */
const SSE_PING_MS = 15_000;

export interface InspectorDeps {
  /** Slices registered with `devtools.expose`, evaluated per request. */
  exposed(): Record<string, unknown>;
  /** Extra routes contributed by the CDP bridge, when it is available. */
  extraRoutes?: () => InspectorRoutes;
}

/** A route table: `"GET /logs"` → handler. */
export type InspectorRoutes = Record<
  string,
  (req: Request, url: URL) => Response | Promise<Response>
>;

export interface InspectorHandle {
  port: number;
  token: string;
  stop(): Promise<void>;
}

function healthResponse(): Response {
  return json({
    ok: true,
    pid: process.pid,
    lastSeq: sink.lastSeq,
    dropped: sink.dropped,
    file: sink.filePath ?? null,
  });
}

function logsResponse(url: URL): Response {
  const query = parseQuery(url.searchParams);
  const events = sink.read(query);
  return json({
    events,
    /** Cursor to pass as `since` on the next poll. */
    lastSeq: sink.lastSeq,
    dropped: sink.dropped,
    query,
  });
}

/** Stream events as SSE. `?since=<seq>` replays from the buffer before going
 *  live; `?replay=0` opts out. */
function streamResponse(req: Request, url: URL): Response {
  const query = parseQuery(url.searchParams);
  const wantsReplay = url.searchParams.get("replay") !== "0";
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = (event: DevEvent): void => {
        controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const close = (): void => {
        unsubscribe?.();
        unsubscribe = undefined;
        if (ping !== undefined) clearInterval(ping);
        ping = undefined;
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      // Preamble comment, so the client sees bytes (a live connection) even when
      // nothing matches yet and replay is off.
      controller.enqueue(encoder.encode(": mirin inspector stream\n\n"));

      // Replay is bounded by the same `limit` as `/logs` (default 200).
      if (wantsReplay) {
        for (const event of sink.read(query)) frame(event);
      }

      // Live events pass the same predicate as `/logs`. `since` is a replay
      // cursor only — it must not suppress anything arriving now.
      const live = { ...query, since: undefined, limit: undefined };
      unsubscribe = sink.subscribe((event) => {
        if (matches(event, live)) frame(event);
      });

      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, SSE_PING_MS);
      ping.unref?.();

      req.signal.addEventListener("abort", close);
    },
    cancel() {
      unsubscribe?.();
      if (ping !== undefined) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

/** Run a route, turning a thrown handler into a 500 rather than a dropped socket. */
async function runRoute(
  handler: (req: Request, url: URL) => Response | Promise<Response>,
  req: Request,
  url: URL,
): Promise<Response> {
  try {
    return await handler(req, url);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 500);
  }
}

/** Bind the inspector. Returns undefined when disabled or the port cannot be
 *  bound — a diagnostic surface must never stop an app from starting. */
export function startInspector(deps: InspectorDeps): InspectorHandle | undefined {
  if (!devtoolsOptions().inspector) return undefined;

  const token = crypto.randomUUID();
  const routes: InspectorRoutes = {
    "GET /health": () => healthResponse(),
    "GET /state": () => json(stateSnapshot(deps.exposed())),
    "GET /logs": (_req, url) => logsResponse(url),
    "GET /logs/stream": (req, url) => streamResponse(req, url),
    ...(deps.extraRoutes?.() ?? {}),
  };
  // Data, not a prebuilt Response: `Response.clone()` resolves to the un-augmented
  // fetch type when a consumer's tsconfig omits the DOM lib.
  const index = {
    service: "mirin-inspector",
    version: 1,
    routes: Object.keys(routes).sort(),
    hint: "every request needs ?token=… or an Authorization: Bearer header",
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      // Not `async`: an async `fetch` widens the inferred Response and stops
      // matching Bun's handler overloads. Async work goes through `runRoute`.
      fetch(req) {
        const url = new URL(req.url);
        const rejection = rejectUnauthorized(req, url, token);
        if (rejection !== undefined) return rejection;

        if (req.method === "GET" && url.pathname === "/") return json(index);

        const handler = routes[`${req.method} ${url.pathname}`];
        if (handler === undefined) {
          return jsonError(`no such route: ${req.method} ${url.pathname}`, 404, {
            routes: Object.keys(routes).sort(),
          });
        }
        return runRoute(handler, req, url);
      },
    });
  } catch {
    return undefined;
  }

  const port = server.port;
  if (port == null) {
    void server.stop(true);
    return undefined;
  }

  return {
    port,
    token,
    stop: async () => {
      await server.stop(true);
    },
  };
}
