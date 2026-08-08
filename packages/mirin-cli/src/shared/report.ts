/**
 * Output shaping for CLI commands. Invariant: in `--json` mode nothing but JSON
 * reaches stdout, process-wide — `childStdio` and `build()` route child output away.
 */

import type { $ } from "bun";

export type ChildStdio = ["ignore", "inherit" | 2, "inherit"];

export interface Reporter {
  readonly json: boolean;
  /** Progress for a person. Suppressed in JSON mode. */
  info(message: string): void;
  /** Progress for a tool. Suppressed in human mode. */
  event(phase: string, data?: Record<string, unknown>): void;
  /** The final outcome. JSON mode prints `payload`; human mode calls `render`. */
  finish(payload: Record<string, unknown>, render: () => void): void;
  /** `stdio` for a long-lived child (Vite, the app): in JSON mode its stdout is
   *  pointed at stderr, off the stream a caller parses. */
  readonly childStdio: ChildStdio;
  /** Await a build subprocess under the same rule — `bun build` writes its
   *  bundle summary to stdout. */
  build(shell: $.ShellPromise): Promise<void>;
}

export function createReporter(json: boolean): Reporter {
  return {
    json,
    childStdio: ["ignore", json ? 2 : "inherit", "inherit"],
    info(message) {
      if (!json) console.log(message);
    },
    event(phase, data) {
      if (json) console.log(JSON.stringify({ ts: Date.now(), phase, ...data }));
    },
    async build(shell) {
      // Stream live: a cold `cargo build` takes minutes, and buffering looks like a hang.
      if (!json) {
        await shell;
        return;
      }
      // Replay on stderr rather than dropping, or a failed build reports only its exit status.
      try {
        const output = await shell.quiet();
        writeToStderr(output.stdout, output.stderr);
      } catch (err) {
        writeToStderr(...capturedStreams(err));
        throw err;
      }
    },
    finish(payload, render) {
      if (json) console.log(JSON.stringify({ ts: Date.now(), phase: "result", ...payload }));
      else render();
    },
  };
}

/** A `ShellError` carries the output the failed command produced; a plain Error does not. */
function capturedStreams(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const shellError = value as Record<string, unknown>;
  return [shellError.stdout, shellError.stderr];
}

function writeToStderr(...chunks: unknown[]): void {
  for (const chunk of chunks) {
    if (chunk instanceof Uint8Array && chunk.byteLength > 0) process.stderr.write(chunk);
  }
}
