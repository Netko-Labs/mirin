/**
 * `mirin check` — boot the app once, look at it, report, exit (docs/agent-devtools.md).
 *
 * The gap this fills: `mirin dev` is a long-lived interactive process. A tool that
 * runs it in the background cannot tell whether the app came up, whether the window
 * rendered, or whether the UI threw — it just has a pid. `mirin check` runs the same
 * startup path, waits for a window, captures a screenshot and an accessibility
 * snapshot, collects the errors, stops the app, and **exits non-zero when something
 * went wrong**. That makes "did my change work?" answerable the same way a test is.
 *
 *   mirin check                 human summary
 *   mirin check --json          one JSON object on stdout
 *   mirin check --timeout 60000 allow a slow first build
 */

import type { CheckScenario } from "mirinjs/check";
import type { DevEvent } from "mirinjs/devtools/session";
import { readEventsFile, sessionPaths } from "mirinjs/devtools/session";
import { dev } from "./dev.ts";
import type { ScenarioOutcome } from "./shared/driver.ts";
import { InspectorClient } from "./shared/inspector.ts";
import { createReporter, type Reporter } from "./shared/report.ts";
import { loadScenario, runScenario } from "./shared/scenario.ts";

/** How long to wait for the app to show a window before giving up. */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Quiet time after the first window appears, so the capture shows painted UI
 *  rather than an empty frame. */
const DEFAULT_SETTLE_MS = 1_000;

export interface CheckOptions {
  timeoutMs?: number;
  settleMs?: number;
  json?: boolean;
  /** Path to a scenario module (`mirin check --scenario ./check.ts`). */
  scenario?: string;
}

export interface CheckReport {
  ok: boolean;
  /** Why the check failed, when it did. */
  reason?: string;
  session: string | null;
  inspector: string | null;
  windows: { id: number; name?: string; url?: string; title?: string }[];
  /** Path to the captured screenshot, when one was taken. */
  screenshot: string | null;
  /** The accessibility snapshot of the first window, when one was taken. */
  snapshot: string | null;
  /**
   * Slices the app published with `devtools.expose`, read at the end of the run.
   * State the DOM cannot show is often the fastest explanation for a failed check.
   */
  exposed: Record<string, unknown>;
  /** Error-level events from the run — the actionable part. */
  errors: DevEvent[];
  eventCount: number;
  durationMs: number;
  /** Present when `--scenario` ran: what it did, and where it stopped. */
  scenario?: { file: string } & ScenarioOutcome;
}

// ---- narrowing of inspector responses ----

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function windowsOf(state: unknown): CheckReport["windows"] {
  const list = record(state).windows;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const win = record(entry);
    const id = win.id;
    if (typeof id !== "number") return [];
    return [
      {
        id,
        ...(typeof win.name === "string" ? { name: win.name } : {}),
        ...(typeof win.url === "string" ? { url: win.url } : {}),
        ...(typeof win.title === "string" ? { title: win.title } : {}),
      },
    ];
  });
}

/** Poll `/state` until a window exists, or the deadline passes. */
async function waitForWindow(
  client: InspectorClient,
  deadline: number,
): Promise<CheckReport["windows"]> {
  let last: CheckReport["windows"] = [];
  while (Date.now() < deadline) {
    try {
      last = windowsOf(await client.get("/state"));
      if (last.length > 0) return last;
    } catch {
      // The inspector may still be binding; keep trying until the deadline.
    }
    await Bun.sleep(250);
  }
  return last;
}

async function capture(client: InspectorClient, report: CheckReport): Promise<void> {
  try {
    const shot = record(await client.get("/screenshot"));
    if (typeof shot.path === "string") report.screenshot = shot.path;
  } catch (err) {
    report.errors.push(syntheticError(`screenshot failed: ${message(err)}`));
  }
  try {
    const snap = record(await client.get("/snapshot"));
    if (typeof snap.snapshot === "string") report.snapshot = snap.snapshot;
  } catch (err) {
    report.errors.push(syntheticError(`snapshot failed: ${message(err)}`));
  }
  try {
    report.exposed = record(record(await client.get("/state")).exposed);
  } catch {
    // The app publishing nothing is the common case; not worth an error.
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failure of the check itself, shaped like a stream event so one list suffices. */
function syntheticError(text: string): DevEvent {
  return { seq: 0, ts: Date.now(), src: "main", level: "error", type: "check.error", msg: text };
}

function renderReport(report: CheckReport): void {
  const mark = report.ok ? "✓" : "✗";
  console.log(`\n${mark} mirin check ${report.ok ? "passed" : "failed"} in ${report.durationMs}ms`);
  if (report.reason !== undefined) console.log(`  reason: ${report.reason}`);

  if (report.windows.length > 0) {
    console.log(`  windows: ${report.windows.length}`);
    for (const win of report.windows) {
      const label = [win.name, win.title].filter(Boolean).join(" / ");
      console.log(
        `    #${win.id}${label.length > 0 ? ` ${label}` : ""} ${win.url ?? ""}`.trimEnd(),
      );
    }
  }
  if (report.scenario !== undefined) {
    const { file, steps, screenshots, failure } = report.scenario;
    console.log(`  scenario: ${file}`);
    for (const step of steps) {
      const mark = step.ok ? "✓" : "✗";
      console.log(`    ${mark} ${step.name}${step.ms >= 0 ? ` (${step.ms}ms)` : ""}`);
    }
    if (failure !== undefined) console.log(`    → ${failure.message}`);
    for (const shot of screenshots) console.log(`    shot: ${shot}`);
  }
  const exposedKeys = Object.keys(report.exposed);
  if (exposedKeys.length > 0) {
    console.log(`  app state: ${JSON.stringify(report.exposed).slice(0, 400)}`);
  }
  if (report.screenshot !== null) console.log(`  screenshot: ${report.screenshot}`);
  if (report.session !== null) console.log(`  session: ${report.session}`);
  console.log(`  events: ${report.eventCount}, errors: ${report.errors.length}`);

  for (const error of report.errors.slice(0, 10)) {
    console.log(`\n  [${error.src}] ${error.type}: ${error.msg}`);
    const stack = record(error.data).stack;
    if (Array.isArray(stack)) {
      for (const frame of stack.slice(0, 4)) console.log(`      at ${String(frame)}`);
    }
  }
  if (report.errors.length > 10) {
    console.log(`\n  … ${report.errors.length - 10} more errors (see the session's events.jsonl)`);
  }
  if (report.snapshot !== null) {
    console.log(`\n  ui snapshot:\n${report.snapshot.replace(/^/gm, "    ")}`);
  }
}

/** Run the check. Returns the process exit code: 0 when the app came up clean. */
export async function check(
  projectDir = process.cwd(),
  options: CheckOptions = {},
): Promise<number> {
  const reporter: Reporter = createReporter(options.json === true);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const startedAt = Date.now();

  const report: CheckReport = {
    ok: false,
    session: null,
    inspector: null,
    windows: [],
    screenshot: null,
    snapshot: null,
    exposed: {},
    errors: [],
    eventCount: 0,
    durationMs: 0,
  };

  reporter.event("start", { projectDir, timeoutMs });

  // Load the scenario before anything is built: a typo in the path should cost a
  // second, not a cold compile.
  let scenario: CheckScenario | undefined;
  if (options.scenario !== undefined) {
    try {
      scenario = await loadScenario(projectDir, options.scenario);
    } catch (err) {
      report.reason = message(err);
      report.durationMs = Date.now() - startedAt;
      reporter.finish({ ...report }, () => renderReport(report));
      return 1;
    }
  }

  await dev(projectDir, {
    // Inherit the output mode: in JSON mode `mirin dev`'s prose would otherwise
    // interleave with the report and break parsing.
    json: options.json === true,
    async onLaunched(context) {
      const deadline = Date.now() + timeoutMs;
      const session = context.session;
      if (session === undefined) {
        report.reason = "no dev session was created — devtools artifacts are unavailable";
        return;
      }
      report.session = session.paths.dir;

      reporter.event("await-inspector");
      const endpoint = await session.waitForInspector(Math.max(1_000, deadline - Date.now()));
      if (endpoint === undefined) {
        report.reason = "the app never published an inspector endpoint";
        return;
      }
      report.inspector = `http://127.0.0.1:${endpoint.port}`;
      const client = new InspectorClient(endpoint);

      reporter.event("await-window");
      report.windows = await waitForWindow(client, deadline);
      if (report.windows.length === 0) {
        report.reason = `no window appeared within ${timeoutMs}ms`;
        return;
      }

      // Let the first paint land before driving or capturing, or the screenshot
      // shows an empty frame and the snapshot an empty tree.
      await Bun.sleep(settleMs);

      if (scenario !== undefined && options.scenario !== undefined) {
        reporter.event("scenario", { file: options.scenario });
        const outcome = await runScenario(client, scenario, (name) =>
          reporter.event("step", { name }),
        );
        report.scenario = { file: options.scenario, ...outcome };
        if (outcome.failure !== undefined) {
          report.reason = `scenario failed at "${outcome.failure.step}": ${outcome.failure.message}`;
        }
      }

      // Captured after the scenario, so the artifact shows the state the run
      // ended in — including the state it failed in.
      reporter.event("capture", { windows: report.windows.length });
      await capture(client, report);
    },
  });

  // Read the stream from disk rather than the inspector: by now the app has exited,
  // and the file is the complete record of the run.
  if (report.session !== null) {
    const events = readEventsFile(sessionPaths(report.session).events);
    report.eventCount = events.length;
    report.errors.push(...events.filter((event) => event.level === "error"));
  }

  report.durationMs = Date.now() - startedAt;
  report.ok = report.reason === undefined && report.errors.length === 0;
  if (!report.ok && report.reason === undefined) {
    report.reason = `${report.errors.length} error-level event(s) during startup`;
  }

  reporter.finish({ ...report }, () => renderReport(report));
  return report.ok ? 0 : 1;
}
