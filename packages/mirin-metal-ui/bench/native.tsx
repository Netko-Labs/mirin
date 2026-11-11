/**
 * Native click-to-frame benchmark. Opens the example browser in a real
 * window, clicks between examples through the simulation channel (no desktop
 * input), and lines up the driver's timings with the renderer's
 * `MIRIN_METAL_TRACE` log to split each click into stages.
 *
 *   bun bench/native.tsx [host-binary] [clicks] [--visible] [--trace=<path>]
 *
 * Runs in an off-screen virtual compositor (kwin_wayland --virtual) unless
 * `--visible` is passed.
 *
 * The accessibility rows are the host's `access:` trace lines (the tree
 * brought in line after a frame: nodes made again, nodes handed to the
 * adapter, time on the window's thread) and its CPU over each part (every
 * thread, so the adapter's too).
 *
 * Defaults to the release host when it exists, then the debug one.
 */

import { existsSync, readFileSync } from "node:fs";
import { type NativeEvent, render, spawnNativeHost, startHeadlessDisplay } from "@mirinjs/metal";
import { Browser } from "../demo/browser.tsx";
import { ThemeProvider } from "../src/provider.tsx";

const target = new URL("../../../crates/mirin-metal/target/", import.meta.url).pathname;
const args = Bun.argv.slice(2);
const binary =
  args.find((arg) => !arg.startsWith("--") && arg.includes("/")) ??
  [`${target}release/mirin-metal-host`, `${target}debug/mirin-metal-host`].find(existsSync) ??
  "";
const clicks = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 20);
// Off-screen by default; `--visible` runs on the real desktop.
const display = args.includes("--visible") ? null : await startHeadlessDisplay();
if (!display && !args.includes("--visible")) {
  console.error("no headless compositor (kwin_wayland); pass --visible to use the desktop");
  process.exit(1);
}

interface TraceLine {
  at: number;
  message: string;
}
const trace: TraceLine[] = [];
const transport = spawnNativeHost(binary, {
  title: "metal-ui bench",
  width: 1280,
  height: 800,
  env: { ...display?.env, MIRIN_METAL_TRACE: "1" },
  onStderr(line) {
    const match = line.match(/^\[mirin-metal trace\] (\d+\.\d) (.*)$/);
    if (match) trace.push({ at: Number(match[1]), message: match[2] ?? "" });
  },
});

// Record when trees leave the driver and when events arrive.
const sends: number[] = [];
let sentBytes = 0;
const send = transport.send.bind(transport);
transport.send = (json) => {
  sends.push(Date.now());
  sentBytes += json.length;
  send(json);
};
const presses: number[] = [];
transport.onEvent((event: NativeEvent) => {
  if (event.type === "press") presses.push(Date.now());
});

const root = render(
  <ThemeProvider>
    <Browser initial="button-demo" />
  </ThemeProvider>,
  transport,
);
await Bun.sleep(3000);
const hostPid = Number(
  Bun.spawnSync(["pgrep", "-n", "-P", String(process.pid)])
    .stdout.toString()
    .trim(),
);
/** The host's CPU so far (user + system, every thread), in ms. */
const cpuMs = (): number => {
  const fields = readFileSync(`/proc/${hostPid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
  return (Number(fields[11]) + Number(fields[12])) * 10;
};
/** The accessibility updates traced since `at`: time, nodes made, nodes handed over, each. */
const accessSince = (at: number) =>
  trace
    .filter((line) => line.at >= at && line.message.startsWith("access:"))
    .map((line) => ({
      ms: Number(line.message.match(/in ([\d.]+)ms/)?.[1] ?? 0),
      built: Number(line.message.match(/built (\d+) nodes/)?.[1] ?? 0),
      published: Number(line.message.match(/published (\d+)/)?.[1] ?? 0),
    }));

interface Sample {
  toPress: number;
  driver: number;
  toApplied: number;
  toFrame: number;
  total: number;
  render: number;
  bytes: number;
  access: number;
  accessBuilt: number;
  accessPublished: number;
}
const samples: Sample[] = [];
const clicksCpuFrom = cpuMs();
for (let index = 0; index < clicks; index += 1) {
  const name = index % 2 === 0 ? "badge-demo" : "button-demo";
  const id = root.nodeId(`example:${name}`);
  if (!id) throw new Error(`no node for ${name}`);
  sends.length = 0;
  sentBytes = 0;
  presses.length = 0;
  const started = Date.now();
  transport.simulate({ kind: "click", id });
  await Bun.sleep(600);
  const press = presses[0];
  const lastSend = sends.at(-1);
  if (press === undefined || lastSend === undefined) continue;
  const applied = trace.find(
    // A whole tree, or a patch from a host that takes them.
    (line) =>
      line.at >= lastSend &&
      (line.message.startsWith("tree applied") || line.message.startsWith("patch applied")),
  );
  const frame =
    applied && trace.find((line) => line.at >= applied.at && line.message.startsWith("render"));
  if (!applied || !frame) continue;
  const access = accessSince(started);
  samples.push({
    access: access.reduce((total, update) => total + update.ms, 0),
    accessBuilt: access.reduce((total, update) => total + update.built, 0),
    accessPublished: access.reduce((total, update) => total + update.published, 0),
    toPress: press - started,
    driver: lastSend - press,
    toApplied: applied.at - lastSend,
    toFrame: frame.at - applied.at,
    total: frame.at - started,
    render: Number(frame.message.match(/took ([\d.]+)ms/)?.[1] ?? 0),
    bytes: sentBytes,
  });
}

const clicksCpu = (cpuMs() - clicksCpuFrom) / clicks;

// Scroll the example list down and back up, one wheel step per frame.
const list = root.nodeId("example-list");
if (!list) throw new Error("no example list");
// Each step waits for its frame (a nested compositor out of sight asks for
// one a second, which would merge the steps into a few frames).
const scrollSteps = 40;
const scrollFrames: number[] = [];
const scrollStart = Date.now();
const scrollCpuFrom = cpuMs();
for (let step = 0; step < scrollSteps; step += 1) {
  const from = trace.length;
  transport.simulate({ kind: "scroll", id: list, dy: step < scrollSteps / 2 ? 40 : -40 });
  for (let waited = 0; waited < 2500; waited += 4) {
    const frame = trace.slice(from).find((line) => line.message.startsWith("render"));
    if (frame) {
      scrollFrames.push(Number(frame.message.match(/frame ([\d.]+)ms/)?.[1] ?? 0));
      break;
    }
    await Bun.sleep(4);
  }
}
await Bun.sleep(300);
const scrollCpu = (cpuMs() - scrollCpuFrom) / scrollSteps;
const scrollAccess = accessSince(scrollStart);

// Maximize and restore: time from the request to the last frame at the new
// size once the driver has re-rendered for the new viewport (breakpoints).
// `resized` counts the frames drawn at another size than before: a
// compositor that ignores the request (a nested dashi-comp does) leaves it
// at 0, and the time is then only when its next frame callback came.
const resizes: number[] = [];
let resized = 0;
let lastSize = "1280x800";
for (let round = 0; round < 4; round += 1) {
  const before = trace.length;
  const started = Date.now();
  transport.simulate({ kind: "window", action: "zoom" });
  await Bun.sleep(800);
  const sizes = trace
    .slice(before)
    .filter((line) => line.message.startsWith("render"))
    .map((line) => ({ at: line.at, size: line.message.match(/render (\d+x\d+)/)?.[1] }));
  const settled = sizes.at(-1);
  if (settled) resizes.push(settled.at - started);
  for (const { size } of sizes) {
    if (size && size !== lastSize) resized += 1;
    if (size) lastSize = size;
  }
}
root.unmount();
transport.close();
display?.close();
// `--trace=<path>`: the host's whole trace log, for a closer look at a run.
const tracePath = args.find((arg) => arg.startsWith("--trace="))?.slice("--trace=".length);
if (tracePath) {
  await Bun.write(tracePath, trace.map((line) => `${line.at} ${line.message}`).join("\n"));
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const renders = trace
  .filter((line) => line.message.startsWith("render"))
  .map((line) => Number(line.message.match(/took ([\d.]+)ms/)?.[1] ?? 0));
const frames = trace
  .filter((line) => line.message.startsWith("render"))
  .map((line) => Number(line.message.match(/frame ([\d.]+)ms/)?.[1] ?? 0));
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
};
const parses = trace
  .filter((line) => line.message.startsWith("line parsed") && !line.message.includes("(0 KB)"))
  .map((line) => Number(line.message.match(/in ([\d.]+)ms/)?.[1] ?? 0));
// Putting a whole tree, or a patch, in the host's tree (and its state in line).
const applies = trace
  .filter(
    (line) => line.message.startsWith("tree applied") || line.message.startsWith("patch applied"),
  )
  .map((line) => Number(line.message.match(/in ([\d.]+)ms/)?.[1] ?? 0));
const rows: Array<[string, number]> = [
  ["click → press event", median(samples.map((s) => s.toPress))],
  ["press → last tree sent (driver)", median(samples.map((s) => s.driver))],
  ["tree sent → applied (parse + wake)", median(samples.map((s) => s.toApplied))],
  ["applied → frame rendered", median(samples.map((s) => s.toFrame))],
  ["click → frame (total)", median(samples.map((s) => s.total))],
  ["tree parse", median(parses)],
  ["tree or patch apply", median(applies)],
  ["sent per click (KB)", median(samples.map((s) => s.bytes)) / 1024],
  ["tree → elements (all frames)", median(renders)],
  ["full frame (all frames)", median(frames)],
  ["scroll frame", median(scrollFrames)],
  ["scroll frame p95", p95(scrollFrames)],
  ["maximize/restore → settled frame", median(resizes)],
  ["maximize/restore: frames at a new size", resized],
  ["accessibility per click", median(samples.map((s) => s.access))],
  ["accessibility per scroll update", median(scrollAccess.map((update) => update.ms))],
  ["host CPU per click", clicksCpu],
  ["host CPU per scroll step", scrollCpu],
];
const nodes = (values: number[]) => median(values).toFixed(0);
console.log(`host: ${binary}`);
console.log(
  `samples: ${samples.length}/${clicks}, frames: ${renders.length}, scroll frames: ${scrollFrames.length}/${scrollSteps}`,
);
for (const [label, value] of rows) {
  const unit = label.endsWith("(KB)") || label.includes("frames at") ? "" : " ms";
  console.log(`${label.padEnd(38)} ${value.toFixed(1)}${unit}`);
}
console.log(
  `accessibility nodes made/handed over: per click ${nodes(samples.map((s) => s.accessBuilt))}/${nodes(
    samples.map((s) => s.accessPublished),
  )}, per scroll update ${nodes(scrollAccess.map((u) => u.built))}/${nodes(
    scrollAccess.map((u) => u.published),
  )} (${scrollAccess.length} updates)`,
);
process.exit(0);
