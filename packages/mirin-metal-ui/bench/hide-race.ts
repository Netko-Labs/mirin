/**
 * A resident host outlives a window hidden as it opens and opened as it hides.
 *
 *   bun bench/hide-race.ts <host> [--rounds=50] [--window] [--gpu-errors]
 *
 * A host kept warm (`deferred`) is told to open and hide with nothing in
 * between, the ways a shell does it without meaning to (a key that turns out
 * to be a chord shows a surface and takes it back in one breath):
 *
 * - `open hide`: both lines in one write, so the window is hidden in the
 *   turn that opened it, before the compositor configured it or a frame was
 *   drawn;
 * - `opened hide`: the hide is sent the moment the host says the window
 *   opened, which is before its first frame;
 * - `hide open`: with a frame on screen, a hide and the next open in one
 *   write, so the new surface is made in the turn the old one went;
 * - `burst`: open, hide, open, hide and open in one write.
 *
 * After each the host has to show a window and draw it (`frame`), which is
 * what a host that died in its GPU layer cannot do. By default the window is
 * a layer surface, as a shell's are; `--window` makes it a plain one.
 *
 * Prints how many rounds of each kind ran and how long a round took, and
 * exits non-zero when the host went away, an open failed, a frame did not
 * come, or (with `--gpu-errors`) the host logged an error from its GPU
 * layer. Needs a Wayland compositor that presents (and wlr-layer-shell
 * without `--window`): `bench/gates.ts` runs it in a nested one.
 */

import { type NativeHostOptions, spawnNativeHost } from "@mirinjs/metal";

/** How long the frame after a round may take before it counts as not having come. */
const FRAME_MS = 10_000;
const KINDS = ["open hide", "opened hide", "hide open", "burst"] as const;
type Kind = (typeof KINDS)[number];
/** What a GPU layer that lost its surface says (the errors Dashi's capsule met). */
const GPU_ERROR = /ERROR_[A-Z_]+|Failed to create surface|swapchain|panicked/;

const args = Bun.argv.slice(2);
const [binary] = args.filter((arg) => !arg.startsWith("--"));
const rounds = Number(args.find((arg) => arg.startsWith("--rounds="))?.slice(9) ?? 50);
const strict = args.includes("--gpu-errors");
if (!binary || !Number.isInteger(rounds) || rounds < 1) {
  console.error("usage: bun bench/hide-race.ts <host> [--rounds=50] [--window] [--gpu-errors]");
  process.exit(2);
}
const surface: NativeHostOptions["surface"] = args.includes("--window")
  ? undefined
  : {
      layer: "overlay",
      anchor: ["bottom", "left", "right"],
      exclusiveZone: -1,
      keyboard: "none",
      namespace: "hide-race",
    };
const OPEN = JSON.stringify({
  open: { title: "hide race", width: 320, height: 120, ...(surface ? { surface } : {}) },
});
const HIDE = '{"hide":true}';

let opened = 0;
let frames = 0;
let gone = false;
const failures: string[] = [];
const gpuErrors: string[] = [];
let heard: (() => void) | undefined;
const transport = spawnNativeHost(binary, {
  deferred: true,
  env: { MIRIN_METAL_TRACE: "1" },
  onStderr(line) {
    if (line.includes("window opened")) opened += 1;
    else if (line.includes("failed to open window")) failures.push(line);
    else if (GPU_ERROR.test(line)) gpuErrors.push(line);
    else return;
    heard?.();
  },
});
transport.onEvent((event) => {
  if (event.type !== "frame") return;
  frames += 1;
  heard?.();
});
transport.onClose(() => {
  gone = true;
  heard?.();
});

/** Opens sent so far: each must give a window and its first frame. */
let asked = 0;

/** Several lines in one write, so the host reads them in one turn. */
function lines(...all: string[]): void {
  asked += all.filter((line) => line === OPEN).length;
  transport.send(all.join("\n"));
}

/** Wait until `done` says so, the host goes, or `ms` pass; whether it was `done`. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!done() && !gone && failures.length === 0 && performance.now() < deadline) {
    await new Promise<void>((resolve) => {
      heard = resolve;
      setTimeout(resolve, 50);
    });
  }
  return done();
}

/** Every open sent so far has its window and its first frame. */
const caughtUp = (): boolean => opened >= asked && frames >= asked;

/** The round's lines; it ends with the window either shown or hidden. */
async function race(kind: Kind): Promise<"shown" | "hidden"> {
  switch (kind) {
    case "open hide":
      lines(OPEN, HIDE);
      return "hidden";
    case "opened hide": {
      const before = opened;
      lines(OPEN);
      await until(() => opened > before, FRAME_MS);
      lines(HIDE);
      return "hidden";
    }
    case "hide open":
      lines(OPEN);
      await until(caughtUp, FRAME_MS);
      lines(HIDE, OPEN);
      return "shown";
    case "burst":
      lines(OPEN, HIDE, OPEN, HIDE, OPEN);
      return "shown";
  }
}

transport.send(
  JSON.stringify({
    type: "view",
    props: { fill: true, center: true, background: "#1f2937" },
    children: [{ type: "text", props: { size: 24, color: "#ffffff" }, children: ["hide race"] }],
  }),
);

const ran = new Map<Kind, number>(KINDS.map((kind) => [kind, 0]));
const lost: string[] = [];
const started = performance.now();
for (let round = 0; round < rounds && !gone && failures.length === 0; round += 1) {
  const kind = KINDS[round % KINDS.length] ?? "burst";
  const state = await race(kind);
  // The host must still show a window and draw it.
  if (state === "hidden") lines(OPEN);
  if (!(await until(caughtUp, FRAME_MS))) {
    lost.push(
      `round ${round} (${kind}): ${asked} opens sent, ${opened} windows, ${frames} first frames${gone ? ", the host went away" : ""}`,
    );
    break;
  }
  ran.set(kind, (ran.get(kind) ?? 0) + 1);
  // Shown for a frame or two on some rounds, hidden at once on the others.
  if (round % 8 >= 4) await Bun.sleep(40);
  lines(HIDE);
}
const elapsed = performance.now() - started;
transport.close();

for (const line of [...failures, ...lost]) console.log(line);
for (const line of gpuErrors.slice(0, 20)) console.log(`gpu: ${line}`);
const total = [...ran.values()].reduce((sum, count) => sum + count, 0);
console.log(
  `hide-race (${surface ? "layer surface" : "window"}): ${total} of ${rounds} rounds (${KINDS.map((kind) => `${ran.get(kind)} ${kind}`).join(", ")}), ` +
    `${opened} windows and ${frames} first frames for ${asked} opens, ${failures.length} failed opens, ${gpuErrors.length} GPU errors, ` +
    `${(elapsed / Math.max(total, 1)).toFixed(1)} ms a round${gone ? ", the host went away" : ""}`,
);
const passed =
  total === rounds &&
  opened === asked &&
  failures.length === 0 &&
  !gone &&
  (!strict || gpuErrors.length === 0);
process.exit(passed ? 0 : 1);
