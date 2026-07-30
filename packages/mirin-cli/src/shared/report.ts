/**
 * Output shaping for CLI commands that both people and tools run.
 *
 * Human mode is what mirin has always printed. `--json` mode replaces it with
 * newline-delimited progress events followed by one result object, so a caller can
 * parse the outcome instead of scraping prose. The two never interleave: in JSON
 * mode nothing but JSON reaches stdout, which is the property that makes it usable
 * in a pipe.
 */

export interface Reporter {
  readonly json: boolean;
  /** Progress for a person. Suppressed in JSON mode. */
  info(message: string): void;
  /** Progress for a tool. Suppressed in human mode. */
  event(phase: string, data?: Record<string, unknown>): void;
  /** The final outcome. JSON mode prints `payload`; human mode calls `render`. */
  finish(payload: Record<string, unknown>, render: () => void): void;
}

export function createReporter(json: boolean): Reporter {
  return {
    json,
    info(message) {
      if (!json) console.log(message);
    },
    event(phase, data) {
      if (json) console.log(JSON.stringify({ ts: Date.now(), phase, ...data }));
    },
    finish(payload, render) {
      if (json) console.log(JSON.stringify({ ts: Date.now(), phase: "result", ...payload }));
      else render();
    },
  };
}
