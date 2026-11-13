/**
 * One start of the example browser's driver, timed in parts. Spawned by
 * `bench/driver.tsx startup`; no JSX here, so nothing loads before the first
 * line. Prints one JSON line: the marks (wall ms since the parent spawned
 * this process, CPU ms of the whole process) and, with BENCH_PROFILE, where
 * the samples fell from the render on (the modules are loaded by then).
 */

import { createElement } from "react";
import { quiet, standIn } from "../../../mirin-metal/bench/lib/standin.ts";

const spawnedAt = Number(process.env.BENCH_SPAWNED_AT ?? Date.now());
const marks: Array<{ name: string; wall: number; cpu: number }> = [];
type Mark = (typeof marks)[number];
function markNow(name: string): Mark {
  const usage = process.cpuUsage();
  return { name, wall: Date.now() - spawnedAt, cpu: (usage.user + usage.system) / 1000 };
}
function mark(name: string): void {
  marks.push(markNow(name));
}
/** The newest patch: the example's own tree. */
let later: Mark | null = null;

mark("bun, react");
const metal = await import("@mirinjs/metal");
mark("@mirinjs/metal (reconciler)");
await import("../../src/jsx-runtime.ts");
mark("metal-ui runtime (Box, tw)");
await import("../../src/icons/index.ts");
mark("icons");
const { ThemeProvider } = await import("../../src/provider.tsx");
const { Browser } = await import("../../demo/browser.tsx");
mark("app modules (browser, button)");

/** Render the browser and wait for the example. */
async function show(): Promise<void> {
  // As the real host: it says it takes patches a moment after it starts
  // (the driver is rendering by then), and the driver holds its first tree
  // for that word. `BENCH_LATE_WORD`: a transport that isn't known to say it
  // first (the first tree goes out without ids, then again with them).
  const late = process.env.BENCH_LATE_WORD !== undefined;
  let announce: (() => void) | null = null;
  let whole = 0;
  let withIds = false;
  const host = standIn({
    patches: false,
    announces: !late,
    onSend(line) {
      // The bench's own resync below is timed apart.
      if (resyncing) return;
      // A patch is the example; a whole tree has ids on its texts once the host takes patches.
      if (line.startsWith('{"patch"')) later = markNow("example loaded and sent");
      else {
        whole += 1;
        const ids = /"type":"text","props":\{"id"/.test(line);
        if (whole === 1) mark("first tree sent (render, commit, serialize)");
        else if (ids && !withIds) mark("tree again with ids (the host takes patches)");
        else mark("the same tree again (nothing changed)");
        withIds ||= ids;
      }
      announce?.();
      announce = null;
    },
  });
  const word = () => host.emit({ type: "protocol", nodeId: "root", patches: 1 });
  if (late) announce = () => setImmediate(word);
  metal.render(
    createElement(ThemeProvider, null, createElement(Browser, { initial: "button-demo" })),
    host.transport,
  );
  if (!late) setImmediate(word);
  // BENCH_UNTIL_TREE: the start alone, for a build that cannot load the example (a bundle).
  if (process.env.BENCH_UNTIL_TREE) {
    while (!withIds) await Bun.sleep(1);
    return;
  }
  await quiet(host, 40);
  if (later) marks.push(later);
  // The whole tree once more: what serializing it alone costs.
  const sent = host.bytes;
  resyncing = true;
  const from = Bun.nanoseconds();
  host.emit({ type: "resync", nodeId: "root", reason: "bench" });
  serializeMs = (Bun.nanoseconds() - from) / 1e6;
  treeBytes = host.bytes - sent;
}

let resyncing = false;
let serializeMs = 0;
let treeBytes = 0;
let table: string | undefined;
if (process.env.BENCH_PROFILE) {
  const { attribute, attributionTable, profiled } = await import(
    "../../../mirin-metal/bench/lib/profile.ts"
  );
  const { profile } = await profiled(show);
  table = attributionTable(attribute(profile));
} else {
  await show();
}
const memory = process.memoryUsage();
console.log(
  JSON.stringify({
    marks,
    serializeMs,
    treeBytes,
    rssMb: memory.rss / 1e6,
    heapMb: memory.heapUsed / 1e6,
    nodeEnv: process.env.NODE_ENV ?? null,
    table,
  }),
);
process.exit(0);
