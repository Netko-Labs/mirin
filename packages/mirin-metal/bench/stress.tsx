/**
 * Large-tree benchmark: a dashboard of `rows × cols` cards (about 6 nodes
 * each, ~15k nodes by default) where each interaction changes one small part.
 * It measures what a whole-tree protocol and GPUI's full per-frame relayout
 * cost as trees grow, which the example-browser bench (`metal-ui`'s
 * `bench/native.tsx`, ~900 nodes) is too small to show.
 *
 *   bun bench/stress.tsx [host-binary] [--rows=100] [--cols=25] [--visible] [--json] [--trace=<path>]
 *
 * Scenarios, each timed from the driver's action to the host's next painted
 * frame (`MIRIN_METAL_TRACE` log):
 * - select: click a card, which toggles its highlight (one node's style).
 * - type: keystrokes into a field above the grid (one text node).
 * - hover: move the pointer onto a card and off (`hoverBackgroundColor`, renderer-side only).
 * - idle: host CPU while nothing changes, and resident memory.
 *
 * Runs in an off-screen compositor unless `--visible` (see `startHeadlessDisplay`).
 */

import { existsSync, readFileSync } from "node:fs";
import { useState } from "react";
import {
  render,
  spawnNativeHost,
  startHeadlessDisplay,
  Text,
  TextInput,
  View,
} from "../src/index.ts";

const target = new URL("../../../crates/mirin-metal/target/", import.meta.url).pathname;
const args = Bun.argv.slice(2);
const option = (name: string, fallback: number): number =>
  Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const binary =
  args.find((arg) => !arg.startsWith("--") && arg.includes("/")) ??
  [`${target}release/mirin-metal-host`, `${target}debug/mirin-metal-host`].find(existsSync) ??
  "";
const rows = option("rows", 100);
const cols = option("cols", 25);
const display = args.includes("--visible") ? null : await startHeadlessDisplay();
if (!display && !args.includes("--visible")) {
  console.error("no headless compositor; pass --visible to use the current display");
  process.exit(1);
}

interface TraceLine {
  at: number;
  message: string;
}
const trace: TraceLine[] = [];
const transport = spawnNativeHost(binary, {
  title: "metal stress bench",
  width: 1280,
  height: 800,
  env: { ...display?.env, MIRIN_METAL_TRACE: "1" },
  onStderr(line) {
    const match = line.match(/^\[mirin-metal trace\] (\d+\.\d) (.*)$/);
    if (match) trace.push({ at: Number(match[1]), message: match[2] ?? "" });
  },
});
const sends: Array<{ at: number; bytes: number }> = [];
const send = transport.send.bind(transport);
transport.send = (json) => {
  sends.push({ at: Date.now(), bytes: json.length });
  send(json);
};

function Card({ index }: { index: number }) {
  const [selected, setSelected] = useState(false);
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
      style={{
        width: 44,
        padding: 4,
        gap: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? "#3b82f6" : "#27272a",
        backgroundColor: selected ? "#1e3a8a" : "#18181b",
        hoverBackgroundColor: "#27272a",
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 9, color: "#a1a1aa" }}>#{index}</Text>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e" }} />
      </View>
      <Text style={{ fontSize: 11, color: "#f4f4f5" }}>{(index * 7919) % 1000}</Text>
    </View>
  );
}

function Dashboard() {
  const [query, setQuery] = useState("");
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={{ color: "#f4f4f5", fontSize: 14 }}>
          stress {rows}×{cols}
        </Text>
        <TextInput
          testID="query"
          value={query}
          onChangeText={setQuery}
          style={{ width: 240, height: 24, color: "#f4f4f5", backgroundColor: "#18181b" }}
        />
        <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{query.length} chars</Text>
      </View>
      <View style={{ flex: 1, gap: 2, overflow: "hidden" }}>
        {Array.from({ length: rows }, (_, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid
          <View key={row} style={{ flexDirection: "row", gap: 2 }}>
            {Array.from({ length: cols }, (_, col) => (
              <Card key={col} index={row * cols + col} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const root = render(<Dashboard />, transport);
await Bun.sleep(4000);
const hostPid = Number(
  Bun.spawnSync(["pgrep", "-n", "-P", String(process.pid)])
    .stdout.toString()
    .trim(),
);

const rendersAfter = (at: number) =>
  trace.filter((line) => line.at >= at && line.message.startsWith("render"));
const frameMs = (line: TraceLine) => Number(line.message.match(/frame ([\d.]+)ms/)?.[1] ?? 0);
const parsesAfter = (at: number) =>
  trace
    .filter((line) => line.at >= at && line.message.startsWith("line parsed"))
    .map((line) => Number(line.message.match(/in ([\d.]+)ms/)?.[1] ?? 0));

interface Sample {
  driver: number;
  parse: number;
  frame: number;
  total: number;
  bytes: number;
}
async function measure(action: () => void, settle = 700): Promise<Sample | null> {
  sends.length = 0;
  const started = Date.now();
  action();
  await Bun.sleep(settle);
  const last = sends.at(-1);
  const after = last?.at ?? started;
  const frame = rendersAfter(after)[0];
  if (!frame) return null;
  return {
    driver: last ? last.at - started : 0,
    parse: parsesAfter(started).reduce((sum, value) => sum + value, 0),
    frame: frameMs(frame),
    total: frame.at - started,
    bytes: sends.reduce((sum, item) => sum + item.bytes, 0),
  };
}

const cardId = (index: number): string => {
  const id = root.nodeId(`card:${index}`);
  if (!id) throw new Error(`no node for card ${index}`);
  return id;
};
const visible = Math.min(rows * cols, cols * 12);

const select: Sample[] = [];
for (let index = 0; index < 20; index += 1) {
  const id = cardId((index * 37) % visible);
  const sample = await measure(() => transport.simulate({ kind: "click", id }));
  if (sample) select.push(sample);
}

const query = root.nodeId("query");
if (!query) throw new Error("no query field");
transport.simulate({ kind: "click", id: query });
await Bun.sleep(300);
const typing: Sample[] = [];
for (let index = 0; index < 20; index += 1) {
  const sample = await measure(() =>
    transport.simulate({ kind: "type", text: String.fromCharCode(97 + (index % 26)) }),
  );
  if (sample) typing.push(sample);
}

const hover: Sample[] = [];
for (let index = 0; index < 20; index += 1) {
  const id = cardId((index * 53) % visible);
  const on = index % 2 === 0;
  // A real pointer move (sim `move`): onto the card, then off the grid.
  const sample = await measure(() =>
    transport.simulate(on ? { kind: "move", id } : { kind: "move", x: 2, y: 2 }),
  );
  if (sample) hover.push(sample);
}

// Idle: host CPU over 3 s with nothing changing, and resident memory.
const ticks = () => {
  const fields = readFileSync(`/proc/${hostPid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
  return Number(fields[11]) + Number(fields[12]);
};
const rss = () =>
  Number(readFileSync(`/proc/${hostPid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024;
await Bun.sleep(500);
const idleFrom = ticks();
const idleFramesFrom = Date.now();
await Bun.sleep(3000);
const idleCpuMs = ((ticks() - idleFrom) * 1000) / 100;
const idleFrames = rendersAfter(idleFramesFrom).length;
const memory = rss();

// `--trace=<path>`: the host's whole trace log, for a closer look at a run.
const tracePath = args.find((arg) => arg.startsWith("--trace="))?.slice("--trace=".length);
if (tracePath) {
  await Bun.write(tracePath, trace.map((line) => `${line.at} ${line.message}`).join("\n"));
}

root.unmount();
transport.close();
display?.close();

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
};
const summary = (samples: Sample[]) => ({
  n: samples.length,
  driver: median(samples.map((s) => s.driver)),
  parse: median(samples.map((s) => s.parse)),
  frame: median(samples.map((s) => s.frame)),
  frameP95: p95(samples.map((s) => s.frame)),
  total: median(samples.map((s) => s.total)),
  kb: median(samples.map((s) => s.bytes)) / 1024,
});
const result = {
  host: binary,
  nodes: rows * cols * 6 + 6,
  select: summary(select),
  type: summary(typing),
  hover: summary(hover),
  idleCpuMsPer3s: idleCpuMs,
  idleFrames,
  rssMb: memory,
};
if (args.includes("--json")) {
  console.log(JSON.stringify(result));
} else {
  console.log(`host: ${binary}\nnodes: ~${result.nodes}`);
  console.log("scenario  n   driver  parse   frame  frame95  total   tree KB");
  for (const name of ["select", "type", "hover"] as const) {
    const s = result[name];
    console.log(
      `${name.padEnd(8)} ${String(s.n).padStart(2)} ${[
        s.driver,
        s.parse,
        s.frame,
        s.frameP95,
        s.total,
        s.kb,
      ]
        .map((v) => v.toFixed(1).padStart(7))
        .join(" ")}`,
    );
  }
  console.log(
    `idle: ${idleCpuMs.toFixed(0)} ms CPU / 3 s, ${idleFrames} frames; RSS ${memory.toFixed(0)} MB`,
  );
}
process.exit(0);
