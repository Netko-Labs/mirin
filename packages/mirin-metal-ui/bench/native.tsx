/**
 * Native click-to-frame benchmark. Opens the example browser in a real
 * window, clicks between examples through the simulation channel (no desktop
 * input), and lines up the driver's timings with the renderer's
 * `MIRIN_METAL_TRACE` log to split each click into stages.
 *
 *   bun bench/native.tsx [host-binary] [clicks] [--visible]
 *
 * Runs in an off-screen virtual compositor (kwin_wayland --virtual) unless
 * `--visible` is passed.
 *
 * Defaults to the release host when it exists, then the debug one.
 */

import { existsSync } from "node:fs";
import { type NativeEvent, render, spawnNativeHost, startHeadlessDisplay } from "@mirinjs/metal";
import { Browser } from "../demo/browser.tsx";
import { ThemeProvider } from "../src/provider.tsx";

const target = new URL("../../../crates/mirin-metal/target/", import.meta.url).pathname;
const args = Bun.argv.slice(2);
const binary =
  args.find((arg) => arg.includes("/")) ??
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

interface Sample {
  toPress: number;
  driver: number;
  toApplied: number;
  toFrame: number;
  total: number;
  render: number;
  bytes: number;
}
const samples: Sample[] = [];
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
  samples.push({
    toPress: press - started,
    driver: lastSend - press,
    toApplied: applied.at - lastSend,
    toFrame: frame.at - applied.at,
    total: frame.at - started,
    render: Number(frame.message.match(/took ([\d.]+)ms/)?.[1] ?? 0),
    bytes: sentBytes,
  });
}

// Scroll the example list down and back up, one wheel step per frame.
const list = root.nodeId("example-list");
if (!list) throw new Error("no example list");
const scrollStart = Date.now();
for (let step = 0; step < 120; step += 1) {
  transport.simulate({ kind: "scroll", id: list, dy: step < 60 ? 40 : -40 });
  await Bun.sleep(16);
}
await Bun.sleep(300);
const scrollFrames = trace
  .filter((line) => line.at >= scrollStart && line.message.startsWith("render"))
  .map((line) => Number(line.message.match(/frame ([\d.]+)ms/)?.[1] ?? 0));

// Maximize and restore: time from the request to the last frame at the new
// size once the driver has re-rendered for the new viewport (breakpoints).
const resizes: number[] = [];
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
}
root.unmount();
transport.close();
display?.close();

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
];
console.log(`host: ${binary}`);
console.log(
  `samples: ${samples.length}/${clicks}, frames: ${renders.length}, scroll frames: ${scrollFrames.length}/120`,
);
for (const [label, value] of rows) {
  console.log(`${label.padEnd(38)} ${value.toFixed(1)}${label.endsWith("(KB)") ? "" : " ms"}`);
}
process.exit(0);
