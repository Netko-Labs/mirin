/**
 * A surface draws its text by subpixels only when the app says it is opaque.
 *
 *   bun bench/surface-text.ts <host>
 *
 * Subpixel antialiasing blends each glyph into the colour behind it, a
 * channel at a time, so that colour has to be the surface's own. A layer
 * surface is transparent where its tree is, and the compositor blends it
 * over whatever is behind: its text is in grays, whatever is asked. One
 * opened with `opaque: true` is opaque as a window is, and takes subpixel.
 *
 * Each case opens one surface with a line of text, asking for subpixel or
 * for grays, and reads what the host drew (`MIRIN_METAL_TRACE_SCENE`): the
 * glyphs are subpixel sprites or monochrome ones.
 *
 * - a window, subpixel asked: subpixel (the check sees them at all);
 * - a layer surface, subpixel asked: grays, as before `opaque`;
 * - an opaque layer surface, subpixel asked: subpixel;
 * - an opaque layer surface, grays asked: grays (`opaque` alone changes no text).
 *
 * Exits non-zero when a case drew the other kind, drew no text, or the host
 * refused the surface (one from before `"opaqueSurface":true`). Needs a
 * Wayland compositor that presents, with wlr-layer-shell, and a GPU with
 * dual-source blending (without it nothing is drawn by subpixels, and the
 * check says so): `bench/gates.ts` runs it in a nested one.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NativeHostOptions, spawnNativeHost } from "@mirinjs/metal";

const [binary] = Bun.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!binary) {
  console.error("usage: bun bench/surface-text.ts <host>");
  process.exit(2);
}

const BAR: NonNullable<NativeHostOptions["surface"]> = {
  layer: "overlay",
  anchor: ["top", "left", "right"],
  keyboard: "none",
  namespace: "surface-text",
};

interface Case {
  name: string;
  surface?: NativeHostOptions["surface"];
  asks: "subpixel" | "grayscale";
  draws: "subpixel" | "grayscale";
}

const CASES: Case[] = [
  { name: "a window, subpixel asked", asks: "subpixel", draws: "subpixel" },
  { name: "a layer surface, subpixel asked", surface: BAR, asks: "subpixel", draws: "grayscale" },
  {
    name: "an opaque layer surface, subpixel asked",
    surface: { ...BAR, opaque: true },
    asks: "subpixel",
    draws: "subpixel",
  },
  {
    name: "an opaque layer surface, grays asked",
    surface: { ...BAR, opaque: true },
    asks: "grayscale",
    draws: "grayscale",
  },
];

const TREE = JSON.stringify({
  type: "view",
  props: { id: "bar", fill: true, background: "#18181b", padding: 8 },
  children: [
    {
      type: "text",
      props: { id: "words", size: 15, color: "#fafafa" },
      children: ["Hamburgefonstiv"],
    },
  ],
});

/** How long a surface may take to open and draw. */
const DRAWN_MS = 20_000;

/** The glyphs of the last frame a host drew, by kind; null when it drew none or went away. */
async function drawn(
  test: Case,
  dump: string,
): Promise<{ subpixel: number; grayscale: number } | string> {
  const stderr: string[] = [];
  const transport = spawnNativeHost(binary as string, {
    title: "surface text",
    width: 480,
    height: 40,
    textAntialiasing: test.asks,
    ...(test.surface ? { surface: test.surface } : {}),
    env: { MIRIN_METAL_CHECK: "1", MIRIN_METAL_TRACE: "1", MIRIN_METAL_TRACE_SCENE: dump },
    onStderr(line) {
      if (
        !line.includes("ms") ||
        line.includes("rejected") ||
        line.includes("MIRIN_METAL_SURFACE")
      ) {
        stderr.push(line);
      }
    },
  });
  let gone = false;
  transport.onClose(() => {
    gone = true;
  });
  const settled = new Promise<boolean>((resolve) => {
    transport.onEvent((event) => {
      if (event.type === "settled") resolve(true);
    });
    transport.onClose(() => resolve(false));
    setTimeout(() => resolve(false), DRAWN_MS);
  });
  transport.send(TREE);
  transport.simulate({ kind: "settle" });
  const ok = await settled;
  if (!gone) transport.close();
  if (!ok) {
    const said = stderr.find((line) => /surface|opaque|unknown field/.test(line));
    return gone ? `the host went away${said ? `: ${said}` : ""}` : "the surface never settled";
  }
  const frames = (await readFile(dump, "utf8").catch(() => "")).split(/^frame .*$/m);
  const last = frames.at(-1) ?? "";
  return {
    subpixel: last.match(/^SubpixelSprite\b/gm)?.length ?? 0,
    grayscale: last.match(/^MonochromeSprite\b/gm)?.length ?? 0,
  };
}

const directory = await mkdtemp(join(tmpdir(), "surface-text-"));
const failures: string[] = [];
try {
  for (const [index, test] of CASES.entries()) {
    const outcome = await drawn(test, join(directory, `${index}.scene`));
    if (typeof outcome === "string") {
      failures.push(`${test.name}: ${outcome}`);
      continue;
    }
    const other = test.draws === "subpixel" ? "grayscale" : "subpixel";
    console.log(
      `${test.name}: ${outcome.subpixel} glyphs by subpixels, ${outcome.grayscale} in grays`,
    );
    if (outcome[test.draws] === 0) failures.push(`${test.name}: no glyph drawn in ${test.draws}`);
    if (outcome[other] > 0) failures.push(`${test.name}: ${outcome[other]} glyphs in ${other}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
for (const failure of failures) console.log(failure);
console.log(`surface-text: ${CASES.length} cases, ${failures.length} wrong`);
process.exit(failures.length === 0 ? 0 : 1);
