/**
 * `bench/driver.tsx startup`: start the example browser's driver in fresh
 * processes (`startup-child.ts`) and report the medians of each part.
 */

import { join } from "node:path";

interface Mark {
  name: string;
  wall: number;
  cpu: number;
}

interface ChildReport {
  marks: Mark[];
  serializeMs: number;
  treeBytes: number;
  rssMb: number;
  heapMb: number;
  nodeEnv: string | null;
  table?: string;
}

export interface StartupOptions {
  runs: number;
  profile: boolean;
  /** Flags for `bun` itself (`--config=…`, `--smol`). */
  bunArgs: string[];
  /** `K=V` for the child's environment. */
  env: string[];
  /** Variables the child starts without. */
  unset: string[];
  json: boolean;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function run(options: StartupOptions, profile: boolean): Promise<ChildReport> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const pair of options.env) {
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  for (const key of options.unset) delete env[key];
  if (profile) env.BENCH_PROFILE = "1";
  else delete env.BENCH_PROFILE;
  env.BENCH_SPAWNED_AT = String(Date.now());
  const child = Bun.spawn(
    [process.execPath, ...options.bunArgs, join(import.meta.dir, "startup-child.ts")],
    { cwd: join(import.meta.dir, "..", ".."), env, stdout: "pipe", stderr: "inherit" },
  );
  const out = await new Response(child.stdout).text();
  await child.exited;
  const line = out.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as ChildReport;
}

export async function startup(options: StartupOptions): Promise<void> {
  // One run first: the transpiler cache and the page cache are then warm for the rest.
  const cold = await run(options, false);
  const reports: ChildReport[] = [];
  for (let index = 0; index < options.runs; index += 1) reports.push(await run(options, false));
  const names = reports[0]?.marks.map((mark) => mark.name) ?? [];
  const rows = names.map((name, index) => {
    const at = (report: ChildReport): Mark => report.marks[index] ?? { name, wall: 0, cpu: 0 };
    const before = (report: ChildReport): Mark =>
      report.marks[index - 1] ?? { name: "", wall: 0, cpu: 0 };
    return {
      name,
      wall: median(reports.map((report) => at(report).wall)),
      cpu: median(reports.map((report) => at(report).cpu)),
      stepWall: median(reports.map((report) => at(report).wall - before(report).wall)),
      stepCpu: median(reports.map((report) => at(report).cpu - before(report).cpu)),
      firstRunWall: at(cold).wall,
    };
  });
  const summary = {
    nodeEnv: reports[0]?.nodeEnv ?? null,
    rows,
    serializeMs: median(reports.map((report) => report.serializeMs)),
    treeKb: (reports[0]?.treeBytes ?? 0) / 1024,
    rssMb: median(reports.map((report) => report.rssMb)),
    heapMb: median(reports.map((report) => report.heapMb)),
  };
  if (options.json) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(
    `driver start, example browser, stand-in host: medians of ${options.runs} runs (NODE_ENV as React sees it: ${summary.nodeEnv ?? "unset"})`,
  );
  console.log(
    `${"".padEnd(48)} ${"step".padStart(6)} ${"cpu".padStart(6)}   ${"at".padStart(6)} ${"cpu".padStart(6)}   first run at`,
  );
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(48)} ${row.stepWall.toFixed(0).padStart(6)} ${row.stepCpu.toFixed(0).padStart(6)}   ${row.wall.toFixed(0).padStart(6)} ${row.cpu.toFixed(0).padStart(6)}   ${row.firstRunWall.toFixed(0).padStart(6)}`,
    );
  }
  console.log(
    `whole tree serialized again: ${summary.serializeMs.toFixed(2)} ms for ${summary.treeKb.toFixed(1)} KB; RSS ${summary.rssMb.toFixed(1)} MB, heap in use ${summary.heapMb.toFixed(1)} MB`,
  );
  if (options.profile) {
    const profiled = await run(options, true);
    console.log("first render to the example's tree, main thread samples:");
    console.log(profiled.table ?? "  (no profile)");
  }
}
