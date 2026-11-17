/**
 * What Dashi's Inks widgets asked of Metal, in one window: numbers in Inter
 * Display at the light weights (beside Regular, as before), a timer's row of
 * 60 dots as one `<Dots>` node, and a "Now" tag that breathes a few steps a
 * second and stands still under Reduce Motion (press the tag to turn it on
 * and off). Needs a host that says `fontWeights`, `displayFont`, `dots` and
 * `pulse` (section 2 of docs/metal.md).
 *
 * 1. cd crates/mirin-metal && cargo build --release --bin mirin-metal-host
 * 2. cd packages/mirin-metal && bun demo/inks.tsx [host] [--still] [--reduce]
 *
 * `--still` stops the row's once-a-second tick, so the only frames left are
 * the tag's (count them with `MIRIN_METAL_TRACE=1`: one `render` line a
 * frame); `--reduce` starts with Reduce Motion on.
 */

import { useEffect, useState } from "react";
import { Dots, render, spawnNativeHost, Text, View } from "../src/index.ts";
import type { FontWeight } from "../src/types.ts";

const INK = "#f4f4f5";
const QUIET = "#a1a1aa";
const still = Bun.argv.includes("--still");
let reduce = Bun.argv.includes("--reduce");

function Number({ weight, label }: { weight: FontWeight; label: string }) {
  return (
    <View style={{ alignItems: "center", gap: 2 }}>
      <Text style={{ fontSize: 56, color: INK, fontFamily: "display", fontWeight: weight }}>
        12:48
      </Text>
      <Text style={{ fontSize: 11, color: QUIET }}>{label}</Text>
    </View>
  );
}

function Inks({ onTag }: { onTag: () => void }) {
  const [lit, setLit] = useState(23);
  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setLit((current) => (current + 1) % 61), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: "#111114", padding: 24, gap: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: 13, color: QUIET, fontWeight: "semibold" }}>TIMER</Text>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 9,
            backgroundColor: "#6e56cf",
          }}
          pulse={{ from: 0.35, to: 1, periodMs: 2000, fps: 4 }}
          onPress={onTag}
        >
          <Text style={{ fontSize: 11, color: "#ffffff", fontWeight: "semibold" }}>Now</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 28, alignItems: "flex-end" }}>
        <Number weight="200" label="Inter Display 200" />
        <Number weight="300" label="Inter Display 300" />
        <Number weight="normal" label="Regular (before)" />
      </View>
      <Dots
        count={60}
        pitch={8}
        radius={2.5}
        lit={lit}
        head={lit}
        headRing
        color={INK}
        unlitColor="#ffffff33"
      />
      <Text style={{ fontSize: 11, color: QUIET }}>
        {lit} of 60 lit · one dots node · Reduce Motion {reduce ? "on" : "off"} (press Now)
      </Text>
    </View>
  );
}

let frames = 0;
function countFrames(line: string): void {
  if (/\brender \d+x\d+ took/.test(line)) frames += 1;
}
if (process.env.MIRIN_METAL_TRACE === "1") {
  const every = 5;
  setInterval(() => {
    console.log(`frames/s ${(frames / every).toFixed(1)} (reduce motion ${reduce ? "on" : "off"})`);
    frames = 0;
  }, every * 1000);
}

const binary =
  Bun.argv[2]?.startsWith("--") === false
    ? Bun.argv[2]
    : new URL("../../../crates/mirin-metal/target/release/mirin-metal-host", import.meta.url)
        .pathname;
const host = spawnNativeHost(binary, {
  title: "Inks on Metal",
  width: 640,
  height: 300,
  reduceMotion: reduce,
  // Under `MIRIN_METAL_TRACE=1` the host logs a `render` line a frame: count them.
  ...(process.env.MIRIN_METAL_TRACE === "1" ? { onStderr: countFrames } : {}),
});
const root = render(<App />, host);

function App() {
  const [, redraw] = useState(0);
  return (
    <Inks
      onTag={() => {
        reduce = !reduce;
        host.setReduceMotion(reduce);
        redraw((n) => n + 1);
      }}
    />
  );
}

host.onClose(() => {
  root.unmount();
  process.exit(0);
});
