/**
 * The checks an engine change has to pass, in one command: every
 * `layout-check.tsx` run of the set, several at a time, each in a nested
 * compositor of its own.
 *
 *   bun bench/gates.ts <host> [--reference=<host>] [--jobs=4] [--only=<text>]
 *     [--logs=<dir>]
 *
 * - With `--reference` (the engine before the change): `grid`, `browser`,
 *   `scroll` and `scroll-fractional` lay out on `<host>` what they do on it.
 * - `<host>` against itself with `MIRIN_METAL_RETAIN=0`, `--scene`, at scale
 *   factors 1, 1.25 and 1.5: those four and `across` draw with retained
 *   subtrees what drawing everything does.
 * - `<host>` kept warm shows its window again after every hide
 *   (`reopen.ts`).
 *
 * Prints a line per check and a summary, and exits non-zero when any check
 * found a difference or did not finish. `--only` runs the checks whose name
 * contains the text; `--logs` keeps each check's output in that directory
 * (otherwise it is shown for a failed check and nothing is left behind).
 *
 * A check needs a compositor that presents, which the headless ones on some
 * machines do not, so each runs in `dashi-comp --backend winit` on a socket
 * of its own. The hosts are driven with `settle` and `MIRIN_METAL_CHECK=1`
 * (`layout-check.tsx`): no check waits a fixed time or hears the person's
 * pointer, so running them side by side, or beside a build, changes no
 * answer. A reference from before `settle` is the exception: it is given
 * fixed waits, which a busy machine or a pointer crossing its window can
 * upset, so a check against one that fails is run once more, alone, after
 * the others, and fails only if it fails again (a real difference is there
 * every time).
 */

import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** One run of a script of `bench/`: `layout-check.tsx` unless it names another. */
type Check = { name: string; args: string[]; script?: string };
/** What the process inside the compositor is told, through its environment. */
type Inside = { script: string; args: string[]; log: string; status: string };
/** The script of most checks; it alone takes `--visible`. */
const LAYOUT_CHECK = "layout-check.tsx";
type Result = { check: Check; passed: boolean; seconds: number; log: string; again: boolean };

/** How long one check may take, compositor and all. */
const CHECK_MS = 10 * 60_000;
/** The line `layout-check.tsx` prints for a host it cannot ask to settle. */
const FIXED_WAITS = "is given fixed waits";
const INSIDE = "MIRIN_GATE_CHECK";
const packageDir = resolve(dirname(import.meta.path), "..");

if (Bun.argv.includes("--inside")) {
  process.exit(await runInside());
}

const args = Bun.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const [hostArg] = args.filter((arg) => !arg.startsWith("--"));
const jobs = Number(option("jobs") ?? 4);
if (!hostArg || !Number.isInteger(jobs) || jobs < 1) {
  console.error(
    "usage: bun bench/gates.ts <host> [--reference=<host>] [--jobs=4] [--only=<text>] [--logs=<dir>]",
  );
  process.exit(2);
}
const comp = Bun.which("dashi-comp");
const runtimeDir = process.env.XDG_RUNTIME_DIR;
if (!comp || !runtimeDir) {
  console.error("gates: needs dashi-comp on the PATH and XDG_RUNTIME_DIR");
  process.exit(2);
}
const host = resolve(hostArg);
const referenceArg = option("reference");
const only = option("only");
const checks = gateSet(host, referenceArg ? resolve(referenceArg) : undefined).filter(
  (check) => only === undefined || check.name.includes(only),
);
if (checks.length === 0) {
  console.error("gates: no check has that name");
  process.exit(2);
}

const kept = option("logs");
const logs = kept ? resolve(kept) : await mkdtemp(join(tmpdir(), "mirin-gates-"));
const started = performance.now();
let results: Result[] = [];
try {
  if (kept) await Bun.$`mkdir -p ${logs}`.quiet();
  results = await runAll(checks, jobs, comp, runtimeDir, logs);
  // A reference given fixed waits: once more, alone (see the top).
  for (const [index, result] of results.entries()) {
    if (result.passed || !result.log.includes(FIXED_WAITS)) continue;
    const again = await runCheck(result.check, index, comp, runtimeDir, logs);
    results[index] = { ...again, again: true };
  }
} finally {
  if (!kept) await rm(logs, { recursive: true, force: true });
}
for (const result of results) report(result);
const failed = results.filter((result) => !result.passed).length;
const elapsed = Math.round((performance.now() - started) / 1000);
console.log(
  `${results.length} checks: ${results.length - failed} passed, ${failed} failed, in ${Math.floor(elapsed / 60)} min ${elapsed % 60} s`,
);
process.exit(failed === 0 ? 0 : 1);

/** The set: layouts against the reference, retained against not by scale, then the window. */
function gateSet(host: string, reference: string | undefined): Check[] {
  const layouts = ["grid", "browser", "scroll", "scroll-fractional"];
  const against: Check[] = reference
    ? layouts.map((app) => ({ name: `layout ${app} vs reference`, args: [app, host, reference] }))
    : [];
  const retained: Check[] = ["1", "1.25", "1.5"].flatMap((scale) =>
    [...layouts, "across"].map((app) => ({
      name: `scene ${app} @${scale} retained vs not`,
      args: [
        app,
        host,
        host,
        "--scene",
        "--env-b=MIRIN_METAL_RETAIN=0",
        `--env-a=MIRIN_METAL_SCALE=${scale}`,
        `--env-b=MIRIN_METAL_SCALE=${scale}`,
      ],
    })),
  );
  const reopen: Check = {
    name: "window opens again after a hide",
    args: [host],
    script: "reopen.ts",
  };
  return [...against, ...retained, reopen];
}

/** Run the checks, `jobs` at a time; the results in the checks' order. */
async function runAll(
  checks: Check[],
  jobs: number,
  comp: string,
  runtimeDir: string,
  logs: string,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < checks.length) {
      const index = next;
      next += 1;
      const check = checks[index];
      if (check) results[index] = await runCheck(check, index, comp, runtimeDir, logs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, checks.length) }, worker));
  return results;
}

/** One check in a nested compositor of its own. */
async function runCheck(
  check: Check,
  index: number,
  comp: string,
  runtimeDir: string,
  logs: string,
): Promise<Result> {
  const began = performance.now();
  const inside: Inside = {
    script: check.script ?? LAYOUT_CHECK,
    args: check.args,
    log: join(logs, `${index}.log`),
    status: join(logs, `${index}.status`),
  };
  await Promise.all([rm(inside.status, { force: true }), rm(inside.log, { force: true })]);
  // The compositor runs a shell command. This one names nothing: what to
  // run comes through the environment, so no path or argument is quoted.
  const child = Bun.spawn(
    [
      comp,
      "--backend",
      "winit",
      "--no-xwayland",
      "-c",
      'exec "$MIRIN_GATE_BUN" "$MIRIN_GATE_SCRIPT" --inside',
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        DASHI_COMP_SOCKET: join(runtimeDir, `mirin-gate-${process.pid}-${index}.sock`),
        MIRIN_GATE_BUN: process.execPath,
        MIRIN_GATE_SCRIPT: import.meta.path,
        [INSIDE]: JSON.stringify(inside),
      },
    },
  );
  // Only this compositor, by its pid, if the check hangs.
  const timer = setTimeout(() => child.kill("SIGKILL"), CHECK_MS);
  await child.exited;
  clearTimeout(timer);
  const status = Bun.file(inside.status);
  const code = (await status.exists()) ? (await status.text()).trim() : "none";
  const logFile = Bun.file(inside.log);
  const log = (await logFile.exists()) ? await logFile.text() : "";
  return {
    check,
    passed: code === "0",
    seconds: (performance.now() - began) / 1000,
    log: code === "none" ? `${log}gates: the check did not finish\n` : log,
    again: false,
  };
}

/** Inside the compositor: run the check, its output to the log, its exit code to the status file. */
async function runInside(): Promise<number> {
  const inside = parseInside(process.env[INSIDE]);
  if (!inside) {
    console.error("gates: --inside is for the compositor gates.ts starts");
    return 2;
  }
  // One descriptor, appending: the check and the hosts it starts all write to it.
  const log = openSync(inside.log, "a");
  const child = Bun.spawn(
    [
      process.execPath,
      join(packageDir, "bench", inside.script),
      ...inside.args,
      ...(inside.script === LAYOUT_CHECK ? ["--visible"] : []),
    ],
    { cwd: packageDir, stdin: "ignore", stdout: log, stderr: log },
  );
  const code = await child.exited;
  closeSync(log);
  await Bun.write(inside.status, `${code}\n`);
  return code;
}

function parseInside(value: string | undefined): Inside | null {
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { script, args, log, status } = parsed as Record<string, unknown>;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    return null;
  }
  // A file of `bench/` by its name, never a path.
  if (typeof script !== "string" || !/^[\w-]+\.tsx?$/.test(script)) return null;
  return typeof log === "string" && typeof status === "string"
    ? { script, args, log, status }
    : null;
}

/** A check's line, and for a failed one what it said. */
function report(result: Result): void {
  const verdict = result.passed ? "ok  " : "FAIL";
  const again = result.again ? " (second run, alone)" : "";
  console.log(`${verdict}  ${result.check.name.padEnd(42)} ${result.seconds.toFixed(1)} s${again}`);
  if (result.passed) return;
  const said = result.log
    .split("\n")
    .filter((line) => line.trim() !== "" && !/ 0 differ$/.test(line) && !/^\s+at /.test(line));
  for (const line of said.slice(-14)) console.log(`      ${line}`);
}
