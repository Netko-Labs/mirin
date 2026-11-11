/**
 * Large-tree benchmark: a dashboard of `rows × cols` cards (about 6 nodes
 * each, ~15k nodes by default) where each interaction changes one small part.
 * It measures what a whole-tree protocol and GPUI's full per-frame relayout
 * cost as trees grow, which the example-browser bench (`metal-ui`'s
 * `bench/native.tsx`, ~900 nodes) is too small to show.
 *
 *   bun bench/stress.tsx [host-binary] [--rows=100] [--cols=25] [--visible] [--json] [--trace=<path>]
 *     [--only=scroll,grow] [--step=40] [--scroll-steps=24]
 *
 * Scenarios, each timed from the driver's action to the host's next painted
 * frame (`MIRIN_METAL_TRACE` log). `parse` is the host reading the line
 * (`line parsed`), `apply` putting it in its tree (`tree applied`, or
 * `patch applied` when the host takes patches); `KB` is what the driver sent.
 * `access` is the accessibility tree after the frame (`access:` in the trace:
 * the nodes built and handed to the adapter, and the time on the window's
 * thread), and `cpu` the host's CPU (all threads, so the adapter's too) per
 * update over the scenario.
 * - select: click a card, which toggles its highlight (one node's style).
 * - type: keystrokes into a field above the grid (one text node).
 * - hover: move the pointer onto a card and off (`hoverBackgroundColor`, renderer-side only).
 * - grow: a banner above the grid changes height, so every row below it moves.
 * - idle: host CPU while nothing changes, and resident memory.
 * Then the same grid inside a `<ScrollView>` (most rows out of view):
 * - scroll: one wheel step (`--step` px) per frame, down and back up; each
 *   step waits for its frame, so the nested compositor's pace doesn't merge them.
 * - grow (scroll), select (scroll): as above, with the rows in the scroll view.
 * - resize: the window's width changes (`setSize`, back and forth by `--resize-by` px,
 *   `--resizes` times), with the rows in the scroll view; each frame at the new size.
 *
 * Runs in an off-screen compositor unless `--visible` (see `startHeadlessDisplay`).
 */

import { existsSync, readFileSync } from "node:fs";
import { useState } from "react";
import {
  render,
  ScrollView,
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
const step = option("step", 40);
const scrollSteps = option("scroll-steps", 24);
// `--only=a,b`: just these scenarios (for a profile of one).
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const runs = (scenario: string): boolean => !only || only.includes(scenario);
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
    // The host's own complaints (a refused line, a patch it couldn't apply).
    else console.error(line);
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
  const [tall, setTall] = useState(false);
  const [scrolls, setScrolls] = useState(false);
  const banner = (
    <View
      testID="banner"
      onPress={() => setTall((value) => !value)}
      style={{ height: tall ? 40 : 12, borderRadius: 4, backgroundColor: "#3f3f46" }}
    />
  );
  const grid = Array.from({ length: rows }, (_, row) => (
    <View key={row} style={{ flexDirection: "row", gap: 2 }}>
      {Array.from({ length: cols }, (_, col) => (
        <Card key={col} index={row * cols + col} />
      ))}
    </View>
  ));
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
        <View
          testID="layout"
          onPress={() => setScrolls((value) => !value)}
          style={{ width: 12, height: 12, backgroundColor: "#52525b" }}
        />
      </View>
      {scrolls ? (
        <ScrollView testID="scroller" style={{ flex: 1, gap: 8 }}>
          {banner}
          <View style={{ gap: 2 }}>{grid}</View>
        </ScrollView>
      ) : (
        <>
          {banner}
          <View style={{ flex: 1, gap: 2, overflow: "hidden" }}>{grid}</View>
        </>
      )}
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
const timedAfter = (at: number, ...prefixes: string[]) =>
  trace
    .filter((line) => line.at >= at && prefixes.some((prefix) => line.message.startsWith(prefix)))
    .map((line) => Number(line.message.match(/in ([\d.]+)ms/)?.[1] ?? 0));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** The accessibility tree's work after `at`: time, nodes built, nodes handed to the adapter. */
const accessAfter = (at: number) => {
  const lines = trace.filter((line) => line.at >= at && line.message.startsWith("access:"));
  const count = (pattern: RegExp) =>
    sum(lines.map((line) => Number(line.message.match(pattern)?.[1] ?? 0)));
  return {
    ms: count(/in ([\d.]+)ms/),
    built: count(/built (\d+) nodes/),
    published: count(/published (\d+)/),
  };
};

interface Sample {
  driver: number;
  parse: number;
  apply: number;
  frame: number;
  total: number;
  bytes: number;
  access: number;
  accessBuilt: number;
  accessPublished: number;
}
/**
 * One interaction, timed to the frame that shows it: the first the host
 * draws after the driver's last line (or after the action, when the driver
 * sends nothing: `sends` false). Waits for that frame instead of a fixed
 * time, since a nested compositor out of sight asks for one a second.
 */
async function measure(action: () => void, sent = true, timeout = 2500): Promise<Sample | null> {
  sends.length = 0;
  const started = Date.now();
  action();
  let frame: TraceLine | undefined;
  let after = started;
  for (let waited = 0; waited < timeout && !frame; waited += 4) {
    await Bun.sleep(4);
    const last = sends.at(-1);
    if (sent && !last) continue;
    after = last?.at ?? started;
    frame = rendersAfter(after)[0];
  }
  if (!frame) return null;
  // The driver may still be sending (a second commit): let it finish.
  await Bun.sleep(60);
  const last = sends.at(-1);
  const access = accessAfter(started);
  return {
    access: access.ms,
    accessBuilt: access.built,
    accessPublished: access.published,
    driver: last ? last.at - started : 0,
    parse: sum(timedAfter(started, "line parsed")),
    apply: sum(timedAfter(started, "tree applied", "patch applied")),
    frame: frameMs(frame),
    total: frame.at - started,
    bytes: sends.reduce((sum, item) => sum + item.bytes, 0),
  };
}

/** The first frame the host draws after `action`, in ms (it sends nothing: a renderer-side change). */
async function frameAfter(action: () => void, timeout = 2500): Promise<number | null> {
  const from = trace.length;
  action();
  for (let waited = 0; waited < timeout; waited += 4) {
    const line = trace.slice(from).find((entry) => entry.message.startsWith("render"));
    if (line) return frameMs(line);
    await Bun.sleep(4);
  }
  return null;
}

const nodeId = (testId: string): string => {
  const id = root.nodeId(testId);
  if (!id) throw new Error(`no node ${testId}`);
  return id;
};
/** Press `testId` `count` times, each timed to its frame. */
async function presses(testId: string, count: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let index = 0; index < count; index += 1) {
    const sample = await measure(() => transport.simulate({ kind: "click", id: nodeId(testId) }));
    if (sample) samples.push(sample);
  }
  return samples;
}

const cardId = (index: number): string => {
  const id = root.nodeId(`card:${index}`);
  if (!id) throw new Error(`no node for card ${index}`);
  return id;
};
const visible = Math.min(rows * cols, cols * 12);

// Host CPU (user + system, every thread) in clock ticks of 10 ms.
const ticks = () => {
  const fields = readFileSync(`/proc/${hostPid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
  return Number(fields[11]) + Number(fields[12]);
};
const cpu: Record<string, number> = {};
/** Run a scenario and note the host CPU it took, in ms per update. */
async function scenario(name: string, updates: number, run: () => Promise<void>): Promise<void> {
  if (!runs(name)) return;
  const from = ticks();
  await run();
  cpu[name] = ((ticks() - from) * 10) / updates;
}

const select: Sample[] = [];
const selects = option("selects", 20);
await scenario("select", selects, async () => {
  for (let index = 0; index < selects; index += 1) {
    const id = cardId((index * 37) % visible);
    const sample = await measure(() => transport.simulate({ kind: "click", id }));
    if (sample) select.push(sample);
  }
});

const query = root.nodeId("query");
if (!query) throw new Error("no query field");
transport.simulate({ kind: "click", id: query });
await Bun.sleep(300);
const typing: Sample[] = [];
const types = option("types", 20);
await scenario("type", types, async () => {
  for (let index = 0; index < types; index += 1) {
    const sample = await measure(() =>
      transport.simulate({ kind: "type", text: String.fromCharCode(97 + (index % 26)) }),
    );
    if (sample) typing.push(sample);
  }
});

const hover: Sample[] = [];
await scenario("hover", 20, async () => {
  for (let index = 0; index < 20; index += 1) {
    const id = cardId((index * 53) % visible);
    const on = index % 2 === 0;
    // A real pointer move (sim `move`): onto the card, then off the grid.
    const sample = await measure(
      () => transport.simulate(on ? { kind: "move", id } : { kind: "move", x: 2, y: 2 }),
      false,
    );
    if (sample) hover.push(sample);
  }
});

let grow: Sample[] = [];
const grows = option("grows", 12);
await scenario("grow", grows, async () => {
  grow = await presses("banner", grows);
});

// Idle: host CPU over 3 s with nothing changing, and resident memory.
const rss = () =>
  Number(readFileSync(`/proc/${hostPid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024;
await Bun.sleep(500);
const idleFrom = ticks();
const idleFramesFrom = Date.now();
await Bun.sleep(3000);
const idleCpuMs = ((ticks() - idleFrom) * 1000) / 100;
const idleFrames = rendersAfter(idleFramesFrom).length;
const memory = rss();

// `--switches=N`: before the scroll view's scenarios, switch between the
// two layouts N times there and back, noting resident memory after each
// (whether memory a switch takes is kept, or taken again each time).
const switches = option("switches", 0);
const rssSwitched: number[] = [];
for (let index = 0; index < switches * 2; index += 1) {
  transport.simulate({ kind: "click", id: nodeId("layout") });
  await Bun.sleep(2000);
  rssSwitched.push(rss());
}
if (switches > 0) {
  console.error(`switches: RSS ${rssSwitched.map((mb) => mb.toFixed(0)).join(" ")} MB`);
}

// The same grid in a scroll view: most rows are out of view.
transport.simulate({ kind: "click", id: nodeId("layout") });
await Bun.sleep(2500);
const scroller = nodeId("scroller");
const scroll: number[] = [];
await scenario("scroll", scrollSteps * 2, async () => {
  for (let index = 0; index < scrollSteps * 2; index += 1) {
    const dy = index < scrollSteps ? step : -step;
    const frame = await frameAfter(() => transport.simulate({ kind: "scroll", id: scroller, dy }));
    if (frame !== null) scroll.push(frame);
  }
});
// Scrolled part of the way down, so rows above the view move too.
transport.simulate({ kind: "scroll", id: scroller, dy: step * 6 });
await Bun.sleep(1200);
let growScrolled: Sample[] = [];
await scenario("grow/sc", 12, async () => {
  growScrolled = await presses("banner", 12);
});
const selectScrolled: Sample[] = [];
await scenario("select/sc", 12, async () => {
  for (let index = 0; index < 12; index += 1) {
    const id = cardId(cols * 8 + ((index * 37) % (cols * 6)));
    const sample = await measure(() => transport.simulate({ kind: "click", id }));
    if (sample) selectScrolled.push(sample);
  }
});

// Resize: the window's width changes, so every row is laid out at a new
// width (the cards in it stay as they are). Timed to the first frame the
// host draws at the new size.
const resizes = option("resizes", 12);
const resizeBy = option("resize-by", 100);
const resize: number[] = [];
// The accessibility tree's work per resize (time, nodes handed over), and
// resident memory before the first and after each (`rssAfter`).
const resizeAccess: number[] = [];
const resizePublished: number[] = [];
const rssBeforeResize = runs("resize") ? rss() : 0;
const rssAfter: number[] = [];
await scenario("resize", resizes, async () => {
  for (let index = 0; index < resizes; index += 1) {
    const width = index % 2 === 0 ? 1280 - resizeBy : 1280;
    const from = trace.length;
    const started = Date.now();
    transport.setSize(width, 800);
    for (let waited = 0; waited < 2500; waited += 4) {
      const line = trace.slice(from).find((entry) => entry.message.startsWith(`render ${width}x`));
      if (line) {
        resize.push(frameMs(line));
        break;
      }
      await Bun.sleep(4);
    }
    // Whatever follows it (the compositor's configure, a second frame).
    await Bun.sleep(300);
    const access = accessAfter(started);
    resizeAccess.push(access.ms);
    resizePublished.push(access.published);
    rssAfter.push(rss());
  }
});
// Resident memory after everything above: with what scrolling put aside
// (the drawings of rows that left the view).
const memoryAtEnd = rss();

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
  apply: median(samples.map((s) => s.apply)),
  frame: median(samples.map((s) => s.frame)),
  frameP95: p95(samples.map((s) => s.frame)),
  total: median(samples.map((s) => s.total)),
  kb: median(samples.map((s) => s.bytes)) / 1024,
  access: median(samples.map((s) => s.access)),
  accessBuilt: median(samples.map((s) => s.accessBuilt)),
  accessPublished: median(samples.map((s) => s.accessPublished)),
});
const result = {
  host: binary,
  nodes: rows * cols * 6 + 8,
  select: { ...summary(select), cpu: cpu.select ?? 0 },
  type: { ...summary(typing), cpu: cpu.type ?? 0 },
  hover: { ...summary(hover), cpu: cpu.hover ?? 0 },
  grow: { ...summary(grow), cpu: cpu.grow ?? 0 },
  scroll: {
    n: scroll.length,
    frame: median(scroll),
    frameP95: p95(scroll),
    cpu: cpu.scroll ?? 0,
  },
  growScrolled: { ...summary(growScrolled), cpu: cpu["grow/sc"] ?? 0 },
  selectScrolled: { ...summary(selectScrolled), cpu: cpu["select/sc"] ?? 0 },
  idleCpuMsPer3s: idleCpuMs,
  idleFrames,
  rssMb: memory,
};
// The resize scenario's frames, beside the others'.
Object.assign(result, {
  resize: {
    n: resize.length,
    frame: median(resize),
    frameP95: p95(resize),
    cpu: cpu.resize ?? 0,
    access: median(resizeAccess),
    accessPublished: median(resizePublished),
    rssBeforeMb: rssBeforeResize,
    rssAfterMb: rssAfter,
  },
  rssAtEndMb: memoryAtEnd,
});
if (args.includes("--json")) {
  console.log(JSON.stringify(result));
} else {
  console.log(`host: ${binary}\nnodes: ~${result.nodes}`);
  console.log(
    "scenario  n   driver  parse   apply   frame  frame95  total      KB  access     cpu  a11y built/published",
  );
  const labels = {
    select: "select",
    type: "type",
    hover: "hover",
    grow: "grow",
    growScrolled: "grow/sc",
    selectScrolled: "select/sc",
  } as const;
  for (const name of Object.keys(labels) as Array<keyof typeof labels>) {
    const s = result[name];
    console.log(
      `${labels[name].padEnd(9)}${String(s.n).padStart(2)} ${[
        s.driver,
        s.parse,
        s.apply,
        s.frame,
        s.frameP95,
        s.total,
        s.kb,
        s.access,
        s.cpu,
      ]
        .map((v) => v.toFixed(1).padStart(7))
        .join(" ")}  ${s.accessBuilt}/${s.accessPublished}`,
    );
  }
  console.log(
    `scroll   ${String(result.scroll.n).padStart(2)} frames of ${scrollSteps * 2} steps of ${step} px: frame ${result.scroll.frame.toFixed(1)} ms, p95 ${result.scroll.frameP95.toFixed(1)} ms, cpu ${result.scroll.cpu.toFixed(1)} ms`,
  );
  console.log(
    `idle: ${idleCpuMs.toFixed(0)} ms CPU / 3 s, ${idleFrames} frames; RSS ${memory.toFixed(0)} MB`,
  );
  console.log(
    `resize   ${String(resize.length).padStart(2)} frames of ${resizes} widths ${resizeBy} px apart: frame ${median(resize).toFixed(1)} ms, p95 ${p95(resize).toFixed(1)} ms, cpu ${(cpu.resize ?? 0).toFixed(1)} ms; RSS at the end ${memoryAtEnd.toFixed(0)} MB`,
  );
  if (resize.length > 0) {
    console.log(
      `resize   access ${median(resizeAccess).toFixed(1)} ms, ${median(resizePublished)} handed over a resize; RSS before ${rssBeforeResize.toFixed(0)} MB, after each ${rssAfter.map((mb) => mb.toFixed(0)).join(" ")}`,
    );
  }
}
process.exit(0);
