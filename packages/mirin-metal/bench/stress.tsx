/**
 * Large-tree benchmark: a dashboard of `rows × cols` cards (about 6 nodes
 * each, ~15k nodes by default) where each interaction changes one small part.
 * It measures what a whole-tree protocol and GPUI's full per-frame relayout
 * cost as trees grow, which the example-browser bench (`metal-ui`'s
 * `bench/native.tsx`, ~900 nodes) is too small to show.
 *
 *   bun bench/stress.tsx [host-binary] [--rows=100] [--cols=25] [--visible] [--json] [--trace=<path>]
 *     [--only=scroll,grow] [--step=40] [--scroll-steps=24] [--shadow] [--memo]
 *     [--low] [--start=scroll] [--selects=20] [--types=20] [--grows=12] [--sc-grows=12] [--sc-selects=12] (how many of each: more for a profile)
 *
 * Scenarios, each timed from the driver's action to the host's next painted
 * frame (`MIRIN_METAL_TRACE` log). `parse` is the host reading the line
 * (`line parsed`), `apply` putting it in its tree (`tree applied`, or
 * `patch applied` when the host takes patches); `KB` is what the driver sent.
 * `access` is the accessibility tree after the frame (`access:` in the trace:
 * the nodes built and handed to the adapter, and the time on the window's
 * thread), and `cpu` the host's CPU (all threads, so the adapter's too) per
 * update over the scenario; `adapter cpu` is the part of it on AccessKit's
 * thread (named `accesskit` by mirin's fork of the adapter: 0 on a host from
 * before), which takes the updates to the accessibility bus, and the
 * `adapter` line what that thread took for the first tree and for the
 * switch to the scroll view (every card's node made anew).
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
 * Then the same cards in columns of twelve, side by side in a view that
 * scrolls across (`overflow: "scroll-x"`):
 * - hscroll: one step (`--step` px) across per frame, right and back left,
 *   `--scroll-steps` each way (sim `scroll` with `dx`).
 *
 * `--shadow` gives every card a small drop shadow (`shadow: "sm"`, a logical
 * pixel below it: off the device grid at a scale factor such as 1.1).
 * `--memo` memoizes the cards (`lib/dashboard.tsx`): typing and growing the
 * banner then render the dashboard and its rows, not every card, the floor
 * of the `driver` column for this app. Without it, as an app that memoizes
 * nothing. `bench/driver.tsx --stress` times the same app without a host.
 *
 * `--low` adds a line with each scenario's tenth-percentile frame: on a
 * machine that is doing other work the median moves with the load, and the
 * fastest frames say what the host itself takes. Compare hosts by it with
 * more of each (`--selects=40`...). A host built with `--features profiling`
 * also traces what each frame ran on the window's thread (`counters.rs`),
 * and `--low` then adds the medians of its instructions and CPU cycles,
 * which the load does not move (instructions) or hardly (cycles).
 *
 * Runs in an off-screen compositor unless `--visible` (see `startHeadlessDisplay`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { render, spawnNativeHost, startHeadlessDisplay } from "../src/index.ts";
import { Dashboard } from "./lib/dashboard.tsx";

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
const shadow = args.includes("--shadow") ? ("sm" as const) : undefined;
// `--only=a,b`: just these scenarios (for a profile of one).
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const runs = (scenario: string): boolean => !only || only.includes(scenario);
// `--start=scroll`: the grid is in its scroll view from the first frame, not
// switched into it (to tell what the scroll view costs from what the switch
// leaves behind); run it with `--only=` the scroll view's scenarios.
const startScrolled = args.includes("--start=scroll");
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

const root = render(
  <Dashboard
    rows={rows}
    cols={cols}
    shadow={shadow}
    memo={args.includes("--memo")}
    start={startScrolled ? "scroll" : "plain"}
  />,
  transport,
);
await Bun.sleep(4000);
const hostPid = Number(
  Bun.spawnSync(["pgrep", "-n", "-P", String(process.pid)])
    .stdout.toString()
    .trim(),
);

// What each scenario's frames ran, when the host counts it (`--low`).
const counted: Record<string, { instructions: number[]; cycles: number[] }> = {};
let counting = "";
/** Note what the frame `line` ran under the scenario being run. */
function count(line: TraceLine): void {
  const match = line.message.match(/([\d.]+)M instructions, ([\d.]+)M cycles/);
  if (!match || !counting) return;
  counted[counting] ??= { instructions: [], cycles: [] };
  counted[counting]?.instructions.push(Number(match[1]));
  counted[counting]?.cycles.push(Number(match[2]));
}

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
  count(frame);
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
    if (line) {
      count(line);
      return frameMs(line);
    }
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
// The same for the accessibility adapter's thread alone (named `accesskit`
// by mirin's fork of the adapter; 0 for a host whose thread has no name).
const adapterTicks = (): number => {
  const tasks = `/proc/${hostPid}/task`;
  let total = 0;
  try {
    for (const task of readdirSync(tasks)) {
      try {
        if (readFileSync(`${tasks}/${task}/comm`, "utf8").trim() !== "accesskit") continue;
        const fields =
          readFileSync(`${tasks}/${task}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
        total += Number(fields[11]) + Number(fields[12]);
      } catch {
        // The thread ended between the listing and the read.
      }
    }
  } catch {
    // The host is gone.
  }
  return total;
};
const cpu: Record<string, number> = {};
const adapterCpu: Record<string, number> = {};
/** Run a scenario and note the host CPU it took, in ms per update (and the adapter's part). */
async function scenario(name: string, updates: number, run: () => Promise<void>): Promise<void> {
  if (!runs(name)) return;
  const from = ticks();
  const adapterFrom = adapterTicks();
  counting = name;
  await run();
  counting = "";
  cpu[name] = ((ticks() - from) * 10) / updates;
  adapterCpu[name] = ((adapterTicks() - adapterFrom) * 10) / updates;
}
// What the adapter's thread took for the first tree (the start, 4 s).
const adapterAtStart = adapterTicks() * 10;

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
const adapterBeforeSwitch = adapterTicks();
const switchedAt = Date.now();
if (!startScrolled) {
  transport.simulate({ kind: "click", id: nodeId("layout") });
  await Bun.sleep(2500);
}
const adapterAtSwitch = (adapterTicks() - adapterBeforeSwitch) * 10;
// And on the window's thread: the tree, and AccessKit taking it there.
const accessAtSwitch = accessAfter(switchedAt);
const adapterTookAtSwitch = sum(
  trace
    .filter((line) => line.at >= switchedAt && line.message.startsWith("access:"))
    .map((line) => Number(line.message.match(/the adapter took ([\d.]+)ms/)?.[1] ?? 0)),
);
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
const growsScrolled = option("sc-grows", 12);
await scenario("grow/sc", growsScrolled, async () => {
  growScrolled = await presses("banner", growsScrolled);
});
const selectScrolled: Sample[] = [];
const selectsScrolled = option("sc-selects", 12);
await scenario("select/sc", selectsScrolled, async () => {
  for (let index = 0; index < selectsScrolled; index += 1) {
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
        count(line);
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

// The cards in columns, scrolled across: each column holds text, which a
// host that moves a drawing only down draws again every step.
const hscroll: number[] = [];
if (runs("hscroll")) {
  transport.simulate({ kind: "click", id: nodeId("layout") });
  await Bun.sleep(2500);
  const across = nodeId("hscroller");
  await scenario("hscroll", scrollSteps * 2, async () => {
    for (let index = 0; index < scrollSteps * 2; index += 1) {
      const dx = index < scrollSteps ? step : -step;
      const frame = await frameAfter(() =>
        transport.simulate({ kind: "scroll", id: across, dy: 0, dx }),
      );
      if (frame !== null) hscroll.push(frame);
    }
  });
}

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
/** The tenth percentile: what the fastest frames took (`--low`). */
const low = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)] ?? 0;
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
  select: { ...summary(select), cpu: cpu.select ?? 0, adapterCpu: adapterCpu.select ?? 0 },
  type: { ...summary(typing), cpu: cpu.type ?? 0, adapterCpu: adapterCpu.type ?? 0 },
  hover: { ...summary(hover), cpu: cpu.hover ?? 0, adapterCpu: adapterCpu.hover ?? 0 },
  grow: { ...summary(grow), cpu: cpu.grow ?? 0, adapterCpu: adapterCpu.grow ?? 0 },
  scroll: {
    n: scroll.length,
    frame: median(scroll),
    frameP95: p95(scroll),
    cpu: cpu.scroll ?? 0,
    adapterCpu: adapterCpu.scroll ?? 0,
  },
  growScrolled: {
    ...summary(growScrolled),
    cpu: cpu["grow/sc"] ?? 0,
    adapterCpu: adapterCpu["grow/sc"] ?? 0,
  },
  selectScrolled: {
    ...summary(selectScrolled),
    cpu: cpu["select/sc"] ?? 0,
    adapterCpu: adapterCpu["select/sc"] ?? 0,
  },
  adapterAtStartMs: adapterAtStart,
  adapterAtSwitchMs: adapterAtSwitch,
  accessAtSwitchMs: accessAtSwitch.ms,
  adapterTookAtSwitchMs: adapterTookAtSwitch,
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
    adapterCpu: adapterCpu.resize ?? 0,
    access: median(resizeAccess),
    accessPublished: median(resizePublished),
    rssBeforeMb: rssBeforeResize,
    rssAfterMb: rssAfter,
  },
  hscroll: {
    n: hscroll.length,
    frame: median(hscroll),
    frameP95: p95(hscroll),
    cpu: cpu.hscroll ?? 0,
    adapterCpu: adapterCpu.hscroll ?? 0,
  },
  rssAtEndMb: memoryAtEnd,
});
if (args.includes("--json")) {
  console.log(JSON.stringify(result));
} else {
  console.log(`host: ${binary}\nnodes: ~${result.nodes}`);
  console.log(
    "scenario  n   driver  parse   apply   frame  frame95  total      KB  access     cpu  a11y built/published  adapter cpu",
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
        .join(
          " ",
        )}  ${`${s.accessBuilt}/${s.accessPublished}`.padEnd(15)}  ${s.adapterCpu.toFixed(1)}`,
    );
  }
  console.log(
    `scroll   ${String(result.scroll.n).padStart(2)} frames of ${scrollSteps * 2} steps of ${step} px: frame ${result.scroll.frame.toFixed(1)} ms, p95 ${result.scroll.frameP95.toFixed(1)} ms, cpu ${result.scroll.cpu.toFixed(1)} ms (adapter ${result.scroll.adapterCpu.toFixed(1)})`,
  );
  console.log(
    `idle: ${idleCpuMs.toFixed(0)} ms CPU / 3 s, ${idleFrames} frames; RSS ${memory.toFixed(0)} MB`,
  );
  console.log(
    `resize   ${String(resize.length).padStart(2)} frames of ${resizes} widths ${resizeBy} px apart: frame ${median(resize).toFixed(1)} ms, p95 ${p95(resize).toFixed(1)} ms, cpu ${(cpu.resize ?? 0).toFixed(1)} ms (adapter ${(adapterCpu.resize ?? 0).toFixed(1)}); RSS at the end ${memoryAtEnd.toFixed(0)} MB`,
  );
  if (resize.length > 0) {
    console.log(
      `resize   access ${median(resizeAccess).toFixed(1)} ms, ${median(resizePublished)} handed over a resize; RSS before ${rssBeforeResize.toFixed(0)} MB, after each ${rssAfter.map((mb) => mb.toFixed(0)).join(" ")}`,
    );
  }
  console.log(
    `hscroll  ${String(hscroll.length).padStart(2)} frames of ${scrollSteps * 2} steps of ${step} px across: frame ${median(hscroll).toFixed(1)} ms, p95 ${p95(hscroll).toFixed(1)} ms, cpu ${(cpu.hscroll ?? 0).toFixed(1)} ms (adapter ${(adapterCpu.hscroll ?? 0).toFixed(1)})`,
  );
  if (args.includes("--low")) {
    const frames = (samples: Sample[]) => samples.map((sample) => sample.frame);
    const lows: Array<[string, number[]]> = [
      ["select", frames(select)],
      ["type", frames(typing)],
      ["hover", frames(hover)],
      ["grow", frames(grow)],
      ["scroll", scroll],
      ["grow/sc", frames(growScrolled)],
      ["select/sc", frames(selectScrolled)],
      ["resize", resize],
      ["hscroll", hscroll],
    ];
    console.log(
      `low      ${lows.map(([name, values]) => `${name} ${low(values).toFixed(2)}`).join(", ")} (frame, tenth percentile, ms)`,
    );
    const names = lows.map(([name]) => name).filter((name) => counted[name]);
    if (names.length > 0) {
      const medians = (pick: "instructions" | "cycles") =>
        names.map((name) => `${name} ${median(counted[name]?.[pick] ?? []).toFixed(2)}`).join(", ");
      console.log(`cycles   ${medians("cycles")} (frame, median, millions)`);
      console.log(`instr    ${medians("instructions")} (frame, median, millions)`);
    }
  }
  console.log(
    `adapter  ${adapterAtStart.toFixed(0)} ms CPU for the first tree, ${adapterAtSwitch.toFixed(0)} ms for the switch to the scroll view (on the window's thread: ${accessAtSwitch.ms.toFixed(1)} ms, AccessKit ${adapterTookAtSwitch.toFixed(1)} of it, ${accessAtSwitch.published} nodes handed over)`,
  );
}
process.exit(0);
