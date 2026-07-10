/**
 * Main-process helpers around `app.sidecar("tool")` — the three ways apps drive
 * a sidecar: one-shot (spawn → collect stdout → exit), a long-lived NDJSON
 * request/response server, and a streaming emitter that's killed on demand.
 */

import type { SidecarProcess } from "mirinjs";
import { app } from "mirinjs";

/** Read a stdout/stderr stream line-by-line, calling `onLine` per line. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
      nl = buf.indexOf("\n");
    }
  }
}

/** One-shot: spawn with args, collect stdout+stderr, resolve on exit. */
export async function runOnce(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = app.sidecar("tool", { args, stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

// --- long-lived NDJSON server (one persistent sidecar, request/response) ---

let server: SidecarProcess | undefined;
const waiters: Array<(line: string) => void> = [];

function ensureServer(): SidecarProcess {
  if (server) return server;
  const proc = app.sidecar("tool", {
    args: ["serve"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  server = proc;
  // Each reply line resolves the oldest pending request (FIFO).
  void readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => waiters.shift()?.(line));
  void proc.exited.then(() => {
    server = undefined;
  });
  return proc;
}

/** Send one request to the persistent server sidecar and await its reply. */
export function serverRequest(op: string, text: string): Promise<unknown> {
  const proc = ensureServer();
  return new Promise((resolve) => {
    waiters.push((line) => {
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: "unparseable reply" });
      }
    });
    const stdin = proc.stdin as Bun.FileSink;
    stdin.write(`${JSON.stringify({ op, text })}\n`);
    stdin.flush();
  });
}

// --- streaming emitter (kill demo) ---

let ticker: SidecarProcess | undefined;

/** Start `tool count`, forwarding each emitted number to `onTick`. */
export function startTicker(onTick: (n: string) => void): number {
  stopTicker();
  const proc = app.sidecar("tool", { args: ["count"], stderr: "inherit" });
  ticker = proc;
  void readLines(proc.stdout as ReadableStream<Uint8Array>, onTick);
  return proc.pid;
}

/** Kill the streaming sidecar (no-op if not running). */
export function stopTicker(): void {
  ticker?.kill();
  ticker = undefined;
}
