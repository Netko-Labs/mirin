/**
 * The driver alone: what the Bun process running an app's React costs,
 * measured on the example browser against a stand-in host (a transport that
 * announces the patch protocol and counts lines; no process, no compositor).
 *
 *   bun bench/driver.tsx startup [--runs=7] [--profile] [--bun=<bun flag>]... [--env=K=V]... [--unset=K]...
 *   bun bench/driver.tsx interact [--rounds=40] [--profile] [--json]
 *   bun bench/driver.tsx memory [--rounds=3] [--json]
 *   bun bench/driver.tsx record <file> [--whole] [--against=<file>]
 *
 * - startup: fresh processes; wall and CPU from spawn to each part of the
 *   start (modules, first tree, the tree again once the host takes patches,
 *   the example). `--bun=--config=<an empty file> --unset=NODE_ENV` starts
 *   without this package's `bunfig.toml` (React's development build, as an
 *   app that defines nothing gets); `--env=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`
 *   without Bun's transpiler cache.
 *   `--profile` adds where the first render's samples fell.
 * - interact: per switch of example, character typed and theme toggle: event
 *   to last line sent, process CPU, bytes; `--profile` splits the main
 *   thread's time (React, className translation, Box, serialization, …).
 * - memory: heap after the start and after rounds of 50 interactions.
 * - record: the wire record of a scripted session (`driver/record.tsx`).
 *
 * Run from this package's directory (its `bunfig.toml` and JSX runtime).
 * `packages/mirin-metal/bench/driver.tsx` times the protocol alone.
 */

const args = Bun.argv.slice(2);
const mode = args[0] ?? "interact";
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const flags = (name: string): string[] =>
  args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
const has = (name: string): boolean => args.includes(`--${name}`);

if (mode === "startup") {
  const { startup } = await import("./driver/startup.ts");
  await startup({
    runs: Number(flag("runs") ?? 7),
    profile: has("profile"),
    bunArgs: flags("bun"),
    env: flags("env"),
    unset: flags("unset"),
    json: has("json"),
  });
} else if (mode === "interact") {
  const { interact } = await import("./driver/interact.tsx");
  await interact(Number(flag("rounds") ?? 40), has("profile"), has("json"));
} else if (mode === "memory") {
  const { memory } = await import("./driver/memory.tsx");
  await memory(Number(flag("rounds") ?? 3), has("json"));
} else if (mode === "record") {
  const path = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
  if (!path) throw new Error("record: a file to write");
  const { record } = await import("./driver/record.tsx");
  await record(path, { whole: has("whole"), against: flag("against") });
} else {
  console.error(`unknown mode ${mode}: startup, interact, memory, or record`);
  process.exit(1);
}
process.exit(process.exitCode ?? 0);
