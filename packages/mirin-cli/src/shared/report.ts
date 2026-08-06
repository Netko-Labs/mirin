/**
 * Output shaping for CLI commands that both people and tools run.
 *
 * Human mode is what mirin has always printed. `--json` mode replaces it with
 * newline-delimited progress events followed by one result object, so a caller can
 * parse the outcome instead of scraping prose. The two never interleave: in JSON
 * mode nothing but JSON reaches stdout, which is the property that makes it usable
 * in a pipe.
 *
 * That invariant covers the whole process, not just this module's own writes — a
 * command like `mirin check` runs Vite, `bun build`, and the app itself, and each
 * of those prints to stdout by default. `childStdio` and `build()` are how a caller
 * hands that output to the reporter instead of letting it reach fd 1 directly.
 */

import type { $ } from "bun";

/**
 * `stdio` for a spawned child: stdin closed, stderr inherited, and stdout either
 * inherited or pointed at fd 2 — see `Reporter.childStdio`.
 */
export type ChildStdio = ["ignore", "inherit" | 2, "inherit"];

export interface Reporter {
  readonly json: boolean;
  /** Progress for a person. Suppressed in JSON mode. */
  info(message: string): void;
  /** Progress for a tool. Suppressed in human mode. */
  event(phase: string, data?: Record<string, unknown>): void;
  /** The final outcome. JSON mode prints `payload`; human mode calls `render`. */
  finish(payload: Record<string, unknown>, render: () => void): void;
  /**
   * `stdio` for a long-lived child whose output is progress, not this command's
   * result — Vite, the app itself. Their stdout is prose, so in JSON mode it is
   * pointed at stderr (fd 2) instead: still visible to anyone watching, but off
   * the stream a caller parses.
   */
  readonly childStdio: ChildStdio;
  /**
   * Await a build subprocess (`bun build`, `cargo build`) under the same rule.
   * `bun build` writes its bundle summary to stdout, which would otherwise land
   * in the middle of the JSON report.
   */
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
      // Human mode streams the build live: a cold `cargo build` takes minutes, and
      // buffering it would be indistinguishable from a hang.
      if (!json) {
        await shell;
        return;
      }
      // JSON mode has to capture it. Replay on stderr rather than dropping it, or a
      // failed build would report only its exit status.
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
