/**
 * A resident host shows its window again after a hide, every time.
 *
 *   bun bench/reopen.ts <host> [--times=20]
 *
 * A host kept warm (`deferred`, as a shell keeps one for its launcher and
 * menus) is opened and hidden `--times` times, with the hide and the next
 * open sent together on some rounds and apart on others. Every open after
 * the first makes a new surface on the GPU context the first one made; when
 * that context came from the one prepared as the host connected, the engine
 * once made that surface without a display and the window did not open
 * ("failed to open window: Failed to create surface"). Exits non-zero when
 * an open failed or did not come.
 *
 * Needs a Wayland compositor that presents: `bench/gates.ts` runs it in a
 * nested one, with the layout checks.
 */

import { spawnNativeHost } from "@mirinjs/metal";

/** How long one open may take before it counts as not having come. */
const OPEN_MS = 10_000;
/** How long after a hide the next open is sent, by round: together, then apart. */
const GAPS_MS = [0, 0, 15, 60, 250];

const args = Bun.argv.slice(2);
const [binary] = args.filter((arg) => !arg.startsWith("--"));
const times = Number(args.find((arg) => arg.startsWith("--times="))?.slice(8) ?? 20);
if (!binary || !Number.isInteger(times) || times < 2) {
  console.error("usage: bun bench/reopen.ts <host> [--times=20]");
  process.exit(2);
}

let opened = 0;
const failures: string[] = [];
let heard: (() => void) | undefined;
const transport = spawnNativeHost(binary, {
  deferred: true,
  env: { MIRIN_METAL_TRACE: "1" },
  onStderr(line) {
    if (line.includes("window opened")) opened += 1;
    else if (line.includes("failed to open window")) failures.push(line);
    else return;
    heard?.();
  },
});
let gone = false;
transport.onClose(() => {
  gone = true;
  heard?.();
});

/** Wait for the host's word on an open: a window, a failure, or its end. */
async function answered(before: number): Promise<boolean> {
  const deadline = performance.now() + OPEN_MS;
  while (opened + failures.length === before && !gone && performance.now() < deadline) {
    await new Promise<void>((resolve) => {
      heard = resolve;
      setTimeout(resolve, 100);
    });
  }
  return opened + failures.length > before;
}

let missing = 0;
for (let round = 0; round < times && !gone; round += 1) {
  const before = opened + failures.length;
  transport.open({ title: "reopen", width: 320, height: 200 });
  if (!(await answered(before))) missing += 1;
  transport.hide();
  await Bun.sleep(GAPS_MS[round % GAPS_MS.length] ?? 0);
}
transport.close();

for (const line of failures) console.log(line);
console.log(
  `reopen: ${times} opens, ${opened} windows, ${failures.length} failed, ${missing} never answered${gone ? ", the host went away" : ""}`,
);
process.exit(opened === times && failures.length === 0 ? 0 : 1);
