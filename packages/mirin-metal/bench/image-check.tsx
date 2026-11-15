/**
 * Which image files a host draws, and what it says of the ones it cannot.
 *
 *   bun bench/image-check.tsx <host> [more files…]
 *
 * Shows the images of `crates/mirin-metal/tests/images` (PNG, WebP, an SVG
 * document, AVIF, a text file named `.png`) and a file that is not there,
 * each with `onError`, and any other files named. Prints for each whether
 * the host drew it or what it said, and exits non-zero when a format the
 * host decodes failed, one it does not was drawn in silence, or the host
 * does not tell (no `"imageError":true` in its `protocol` line).
 *
 * Needs a Wayland compositor that presents:
 * `dashi-comp --backend winit --no-xwayland -c "bun bench/image-check.tsx <host>"`
 * with a `DASHI_COMP_SOCKET` of its own.
 */

import { join, resolve } from "node:path";
import { Image, type NativeEvent, render, spawnNativeHost, View } from "../src/index.ts";

const [binary, ...more] = Bun.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!binary) {
  console.error("usage: bun bench/image-check.tsx <host> [more files…]");
  process.exit(2);
}

const fixtures = resolve(import.meta.dir, "../../../crates/mirin-metal/tests/images");
/** Each file, and whether the host is expected to draw it (unknown for the extra ones). */
const files: Array<{ path: string; draws: boolean | null }> = [
  { path: join(fixtures, "ok.png"), draws: true },
  { path: join(fixtures, "ok.webp"), draws: true },
  { path: join(fixtures, "ok.svg"), draws: true },
  { path: join(fixtures, "ok.avif"), draws: false },
  { path: join(fixtures, "words.png"), draws: false },
  { path: join(fixtures, "nothing-here.png"), draws: false },
  ...more.map((path) => ({ path: resolve(path), draws: null })),
];
const said = new Map<string, string>();

const transport = spawnNativeHost(binary, {
  title: "image check",
  width: 640,
  height: 200,
  env: { MIRIN_METAL_CHECK: "1" },
});
let gone = false;
transport.onClose(() => {
  gone = true;
});
let tells = false;
const settles: Array<() => void> = [];
transport.onEvent((event: NativeEvent) => {
  if (event.type === "protocol") tells = event.imageError === true;
  if (event.type === "settled") settles.shift()?.();
});
const root = render(
  <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", padding: 12, gap: 12 }}>
    {files.map(({ path }) => (
      <Image
        key={path}
        source={path}
        onError={(event) => said.set(path, event.error)}
        style={{ width: 64, height: 48 }}
      />
    ))}
  </View>,
  transport,
);

// A file is read and decoded off the frame: a few rounds for all to land.
for (let round = 0; round < 6 && !gone; round += 1) {
  const answer = new Promise<void>((done) => settles.push(done));
  transport.simulate({ kind: "settle" });
  await Promise.race([answer, Bun.sleep(30_000)]);
  await Bun.sleep(100);
}
root.unmount();

let wrong = 0;
for (const { path, draws } of files) {
  const error = said.get(path);
  const ok = draws === null || draws === (error === undefined);
  if (!ok) wrong += 1;
  console.log(
    `${ok ? "ok   " : "WRONG"} ${path.slice(path.lastIndexOf("/") + 1)}: ${error ?? "drawn"}`,
  );
}
console.log(
  `image-check: ${wrong} wrong${tells ? "" : "; the host does not say when an image cannot be drawn"}${gone ? "; the host went away" : ""}`,
);
process.exit(wrong === 0 && tells && !gone ? 0 : 1);
