/**
 * What one small resident app costs: memory, startup, threads, and idle work
 * of the host process, and the memory of the Bun driver beside it. A desktop
 * runs many such pairs (docs/metal.md section 0b), so this is the floor that
 * multiplies.
 *
 *   bun bench/footprint.tsx [host-binary] [--app=counter|browser] [--runs=3]
 *       [--env=KEY=VALUE]... [--unset=KEY]... [--json] [--visible]
 *
 * Each run starts the app as it really runs: a driver process (`bun
 * demo/counter.tsx`, or metal-ui's `demo/browser.tsx` from its own package
 * directory, where its JSX runtime and `bunfig.toml` apply) that spawns the
 * host. Reported per run, and as medians:
 * - startup: driver spawn to the host's `first content frame painted` trace
 *   line, the host's own share of it, and the CPU each process used by then
 *   (the host's includes the children it waited for, the Vulkan probe).
 * - memory after the idle window: RSS, PSS, private dirty and anonymous
 *   (`smaps_rollup`), the mappings by category and the largest by name
 *   (`smaps`), and the GPU memory of its DRM clients (`fdinfo`).
 * - threads, by name.
 * - idle: CPU and wakeups (voluntary context switches) over 5 s.
 *
 * `--env` sets a variable for the driver and the host (`MALLOC_ARENA_MAX=1`)
 * and `--unset` removes one the session set (`VK_LOADER_DRIVERS_SELECT`, to
 * time the host choosing the GPU's driver itself).
 * Runs in an off-screen compositor unless `--visible` (see `startHeadlessDisplay`).
 */

import { existsSync } from "node:fs";
import { startHeadlessDisplay } from "../src/index.ts";
import {
  type Activity,
  activity,
  activityBetween,
  childRunning,
  cpuMs,
  type Group,
  gpuMemoryKb,
  groupBy,
  type MemoryKb,
  mappings,
  memoryRollup,
  threads,
} from "./lib/procfs.ts";

const here = new URL(".", import.meta.url).pathname;
const target = new URL("../../../crates/mirin-metal/target/", import.meta.url).pathname;
const args = Bun.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const binary =
  args.find((arg) => !arg.startsWith("--") && arg.includes("/")) ??
  [`${target}release/mirin-metal-host`, `${target}debug/mirin-metal-host`].find(existsSync) ??
  "";
const appName = flag("app") ?? "counter";
const runs = Number(flag("runs") ?? 3);
const idleMs = 5000;

/** The driver's command and the directory its Bun configuration comes from. */
interface AppCommand {
  cwd: string;
  script: string;
  args: string[];
}
const APPS: Record<string, AppCommand> = {
  counter: { cwd: `${here}..`, script: "demo/counter.tsx", args: [] },
  browser: {
    cwd: `${here}../../mirin-metal-ui`,
    script: "demo/browser.tsx",
    args: ["button-demo"],
  },
};
const chosenApp = APPS[appName];
if (!chosenApp) {
  console.error(`--app is one of: ${Object.keys(APPS).join(", ")}`);
  process.exit(2);
}

const display = args.includes("--visible") ? null : await startHeadlessDisplay();
if (!display && !args.includes("--visible")) {
  console.error("no headless compositor; pass --visible to use the current display");
  process.exit(1);
}
const extraEnv = Object.fromEntries(
  args
    .filter((arg) => arg.startsWith("--env="))
    .map((arg) => arg.slice("--env=".length).split(/=(.*)/s).slice(0, 2) as [string, string]),
);
const unset = args
  .filter((arg) => arg.startsWith("--unset="))
  .map((arg) => arg.slice("--unset=".length));
const appEnv: Record<string, string> = { MIRIN_METAL_TRACE: "1" };
for (const [key, value] of Object.entries({ ...process.env, ...display?.env, ...extraEnv })) {
  if (value !== undefined && !unset.includes(key)) appEnv[key] = value;
}

interface ProcessReport {
  memory: MemoryKb;
  categories: Group[];
  largest: Group[];
  threads: { count: number; names: Record<string, number> };
  idleCpuMs: number;
  idleWakeups: number;
}

interface Run {
  /** Driver spawn to the host's first content frame, ms. */
  spawnToFrameMs: number;
  /** The host's own start to that frame, ms (its trace line). */
  hostToFrameMs: number;
  hostCpuToFrameMs: number;
  driverCpuToFrameMs: number;
  /** Host trace lines up to the first frame, ms after the host started. */
  timeline: Array<{ atMs: number; message: string }>;
  window: string;
  gpuKb: Record<string, number>;
  host: ProcessReport;
  driver: ProcessReport;
}

function report(pid: number, before: Activity): ProcessReport | null {
  const idle = activityBetween(before, activity(pid));
  const memory = memoryRollup(pid);
  if (!memory) return null;
  const all = mappings(pid);
  return {
    memory,
    categories: groupBy(all, (mapping) => mapping.category),
    largest: groupBy(all, (mapping) => mapping.name || `(${mapping.category})`).slice(0, 14),
    threads: threads(pid),
    idleCpuMs: idle.runMs,
    idleWakeups: idle.wakeups,
  };
}

async function runOnce(app: AppCommand): Promise<Run> {
  const trace: Array<{ at: number; message: string }> = [];
  let cpuAtFrame: { host: number; driver: number } | null = null;
  let hostPid: number | null = null;
  const spawned = Date.now();
  const driver = Bun.spawn([process.execPath, app.script, binary, ...app.args], {
    cwd: app.cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: appEnv,
  });
  const stop = () => {
    try {
      if (hostPid) process.kill(hostPid, "SIGKILL");
    } catch {
      // Already gone.
    }
    driver.kill("SIGKILL");
  };
  process.once("exit", stop);
  // The host inherits the driver's stderr, so its trace arrives here.
  void (async () => {
    const decoder = new TextDecoder();
    const reader = driver.stderr.getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^\[mirin-metal trace\] (\d+\.\d) (.*)$/);
        if (!match) continue;
        trace.push({ at: Number(match[1]), message: match[2] ?? "" });
        if (!cpuAtFrame && match[2]?.startsWith("first content frame")) {
          hostPid ??= childRunning(driver.pid, binary);
          cpuAtFrame = {
            host: (hostPid ? cpuMs(hostPid)?.withChildren : undefined) ?? 0,
            driver: cpuMs(driver.pid)?.own ?? 0,
          };
        }
      }
    }
  })();

  const deadline = Date.now() + 30_000;
  while (!cpuAtFrame) {
    if (Date.now() > deadline || driver.exitCode !== null) {
      stop();
      throw new Error("the app never painted its first content frame");
    }
    await Bun.sleep(5);
  }
  const atFrame: { host: number; driver: number } = cpuAtFrame;
  if (!hostPid) throw new Error("no host process under the driver");
  const host: number = hostPid;
  const frame = trace.find((line) => line.message.startsWith("first content frame"));
  const hostToFrameMs = Number(frame?.message.match(/, (\d+)ms after/)?.[1] ?? 0);
  const hostStarted = (frame?.at ?? spawned) - hostToFrameMs;
  const window =
    trace
      .find((line) => line.message.startsWith("render"))
      ?.message.match(/render (\d+x\d+)/)?.[1] ?? "";

  // Let startup work finish (caches written, threads parked, the heap
  // trimmed three seconds after the last frame), then watch it idle.
  await Bun.sleep(6000);
  const hostBefore = activity(host);
  const driverBefore = activity(driver.pid);
  await Bun.sleep(idleMs);
  const hostReport = report(host, hostBefore);
  const driverReport = report(driver.pid, driverBefore);
  const gpuKb = gpuMemoryKb(host);
  stop();
  process.off("exit", stop);
  await driver.exited;
  if (!hostReport || !driverReport) throw new Error("the app exited while it was measured");
  return {
    spawnToFrameMs: (frame?.at ?? spawned) - spawned,
    hostToFrameMs,
    hostCpuToFrameMs: atFrame.host,
    driverCpuToFrameMs: atFrame.driver,
    timeline: trace
      .filter((line) => line.at <= (frame?.at ?? 0))
      .map((line) => ({
        atMs: Math.round((line.at - hostStarted) * 10) / 10,
        message: line.message,
      })),
    window,
    gpuKb,
    host: hostReport,
    driver: driverReport,
  };
}

const results: Run[] = [];
for (let index = 0; index < runs; index += 1) {
  results.push(await runOnce(chosenApp));
  await Bun.sleep(500);
}
display?.close();

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const over = (pick: (run: Run) => number): number => median(results.map(pick));
const mb = (kb: number): string => (kb / 1024).toFixed(1);
const processSummary = (pick: (run: Run) => ProcessReport) => ({
  rssMb: over((run) => pick(run).memory.rss) / 1024,
  pssMb: over((run) => pick(run).memory.pss) / 1024,
  privateDirtyMb: over((run) => pick(run).memory.privateDirty) / 1024,
  anonymousMb: over((run) => pick(run).memory.anonymous) / 1024,
  threads: over((run) => pick(run).threads.count),
  idleCpuMsPer5s: over((run) => pick(run).idleCpuMs),
  idleWakeupsPer5s: over((run) => pick(run).idleWakeups),
});
const summary = {
  host: binary,
  app: appName,
  env: extraEnv,
  unset,
  runs: results.length,
  window: results[0]?.window ?? "",
  spawnToFrameMs: over((run) => run.spawnToFrameMs),
  hostToFrameMs: over((run) => run.hostToFrameMs),
  hostCpuToFrameMs: over((run) => run.hostCpuToFrameMs),
  driverCpuToFrameMs: over((run) => run.driverCpuToFrameMs),
  gpuMb: Object.fromEntries(
    Object.keys(results[0]?.gpuKb ?? {}).map((kind) => [
      kind,
      over((run) => run.gpuKb[kind] ?? 0) / 1024,
    ]),
  ),
  hostProcess: processSummary((run) => run.host),
  driverProcess: processSummary((run) => run.driver),
};

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...summary, results }, null, 2));
  process.exit(0);
}

const table = (groups: Group[]): string =>
  groups
    .filter((group) => group.rss >= 100)
    .map(
      (group) =>
        `    ${mb(group.pss).padStart(7)} ${mb(group.rss).padStart(7)} ${mb(group.privateDirty).padStart(7)}` +
        ` ${mb(group.rss - group.anonymous).padStart(7)}  ${group.name} (${group.count})`,
    )
    .join("\n");
const last = results.at(-1);
console.log(`host: ${binary}`);
console.log(`app: ${appName} (${summary.window}), ${results.length} runs, medians`);
if (Object.keys(extraEnv).length + unset.length > 0) {
  console.log(`env: ${JSON.stringify(extraEnv)}, unset: ${unset.join(" ") || "none"}`);
}
console.log(
  `startup: spawn → first content frame ${summary.spawnToFrameMs.toFixed(0)} ms ` +
    `(host alone ${summary.hostToFrameMs.toFixed(0)} ms); CPU by then: host ` +
    `${summary.hostCpuToFrameMs.toFixed(0)} ms, driver ${summary.driverCpuToFrameMs.toFixed(0)} ms`,
);
for (const [label, proc] of [
  ["host", summary.hostProcess],
  ["driver", summary.driverProcess],
] as const) {
  console.log(
    `${label.padEnd(6)} RSS ${proc.rssMb.toFixed(1)} MB, PSS ${proc.pssMb.toFixed(1)}, ` +
      `private dirty ${proc.privateDirtyMb.toFixed(1)}, anonymous ${proc.anonymousMb.toFixed(1)}; ` +
      `${proc.threads} threads; idle ${proc.idleCpuMsPer5s.toFixed(1)} ms CPU and ` +
      `${proc.idleWakeupsPer5s} wakeups per 5 s`,
  );
}
console.log(
  `host GPU memory (not in RSS): ${
    Object.entries(summary.gpuMb)
      .map(([kind, value]) => `${kind} ${value.toFixed(1)} MB`)
      .join(", ") || "not reported"
  }`,
);
console.log(
  `runs: ${results.map((run) => `${mb(run.host.memory.rss)}/${mb(run.host.memory.pss)}/${run.hostToFrameMs}ms`).join("  ")}  (host RSS/PSS/start)`,
);
if (last) {
  console.log("host mappings, last run (MB):\n        PSS     RSS   dirty    file");
  console.log(table(last.host.categories));
  console.log("  largest:");
  console.log(table(last.host.largest));
  console.log(`host threads: ${JSON.stringify(last.host.threads.names)}`);
  console.log("driver mappings, last run (MB):");
  console.log(table(last.driver.categories));
  console.log(`driver threads: ${JSON.stringify(last.driver.threads.names)}`);
  console.log("host startup, last run (ms after the host started):");
  for (const line of last.timeline) {
    console.log(`  ${line.atMs.toFixed(1).padStart(7)}  ${line.message}`);
  }
}
process.exit(0);
