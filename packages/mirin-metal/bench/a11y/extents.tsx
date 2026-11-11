/**
 * What an assistive technology reads of an app as its content moves: drives
 * a page (a grid of cards and a form in a `<ScrollView>` under a banner)
 * through scrolls, a banner that grows, a selection, typing and a row that
 * comes and goes, and after each step writes the app's whole AT-SPI tree
 * (`dump.py`: roles, names, states, `Component.GetExtents`, actions, text)
 * to `<out-dir>/<step>.txt`.
 *
 *   bench/a11y/run.sh on /dev/null bun bench/a11y/extents.tsx <host> <out-dir> --visible
 *
 * Each dump is asked for as soon as the step's frame is painted, with no
 * time for anything to settle: a query right after a move must find the
 * node where it is now. Two hosts driven through it must give the same
 * dumps (`diff -r <out-a> <out-b>`): a host that tells the bus less about a
 * scroll still answers the same. Under `run.sh` it also turns accessibility
 * off and on again, and reads the tree that comes back (while it is off the
 * app is not on the bus: that read says so).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { useState } from "react";
import {
  render,
  ScrollView,
  spawnNativeHost,
  startHeadlessDisplay,
  Text,
  TextInput,
  View,
} from "../../src/index.ts";

const args = Bun.argv.slice(2);
const [binary, outDir] = args.filter((arg) => !arg.startsWith("--"));
if (!binary || !outDir) {
  console.error("usage: bun bench/a11y/extents.tsx <host> <out-dir> [--visible] [--trace=<path>]");
  process.exit(2);
}
const display = args.includes("--visible") ? null : await startHeadlessDisplay();
const APP = "extents check";
const ROWS = 30;
const COLS = 8;

const complaints: string[] = [];
// `--trace=<path>`: the host's trace with each step's action and reads in it.
const tracePath = args.find((arg) => arg.startsWith("--trace="))?.slice("--trace=".length);
const trace: string[] = [];
const transport = spawnNativeHost(binary, {
  title: APP,
  appName: APP,
  width: 900,
  height: 600,
  env: { ...display?.env, MIRIN_METAL_TRACE: "1", MIRIN_METAL_ACCESS_CHECK: "1" },
  onStderr(line) {
    const match = line.match(/^\[mirin-metal trace\] (\d+\.\d) (.*)$/);
    if (match) trace.push(`${match[1]} ${match[2]}`);
    // The host's own complaints: a refused line, or the accessibility
    // tree's check (`MIRIN_METAL_ACCESS_CHECK`) finding a difference.
    else if (!match) complaints.push(line);
  },
});

function Card({ index }: { index: number }) {
  const [selected, setSelected] = useState(false);
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
      accessibilityState={{ selected }}
      style={{ width: 60, padding: 4, backgroundColor: selected ? "#1e3a8a" : "#18181b" }}
    >
      <Text style={{ fontSize: 11, color: "#f4f4f5" }}>card {index}</Text>
    </View>
  );
}

function Page() {
  const [tall, setTall] = useState(false);
  const [extra, setExtra] = useState(false);
  const [name, setName] = useState("");
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <View
        testID="banner"
        onPress={() => setTall((value) => !value)}
        accessibilityLabel="Banner"
        style={{ height: tall ? 50 : 14, backgroundColor: "#3f3f46" }}
      />
      <ScrollView testID="scroller" style={{ flex: 1, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View
            testID="more"
            focusable
            onPress={() => setExtra((value) => !value)}
            style={{ padding: 4, backgroundColor: "#27272a" }}
          >
            <Text style={{ color: "#f4f4f5" }}>More</Text>
          </View>
          <TextInput
            testID="name"
            value={name}
            onChangeText={setName}
            placeholder="Name"
            style={{ width: 200, height: 24, color: "#f4f4f5", backgroundColor: "#18181b" }}
          />
        </View>
        {extra ? (
          <View
            accessibilityRole="status"
            accessibilityLabel="An extra row"
            style={{ height: 30 }}
          />
        ) : null}
        <View accessibilityRole="list" accessibilityLabel="Cards" style={{ gap: 2 }}>
          {Array.from({ length: ROWS }, (_, row) => (
            <View key={row} style={{ flexDirection: "row", gap: 2 }}>
              {Array.from({ length: COLS }, (_, col) => (
                <Card key={col} index={row * COLS + col} />
              ))}
            </View>
          ))}
        </View>
        <View
          testID="last"
          focusable
          onPress={() => {}}
          style={{ padding: 4, backgroundColor: "#27272a" }}
        >
          <Text style={{ color: "#f4f4f5" }}>Last</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const root = render(<Page />, transport);
await Bun.sleep(3000);
const id = (testId: string): string => {
  const found = root.nodeId(testId);
  if (!found) throw new Error(`no node ${testId}`);
  return found;
};

mkdirSync(outDir, { recursive: true });
const dump = new URL("./dump.py", import.meta.url).pathname;
let step = 0;
/** Whether the host has drawn a frame since it read a line sent after trace line `from`. */
const shown = (from: number): boolean => {
  const read = trace.findIndex((line, index) => index >= from && line.includes(" line parsed "));
  return read >= 0 && trace.slice(read).some((line) => line.includes(" render "));
};
/**
 * Do `action`, wait for the frame that shows it (the first the host draws
 * after reading what the action sent: one already on its way shows nothing
 * of it), and read the tree at once.
 */
async function after(name: string, action: (() => void) | null): Promise<void> {
  const from = trace.length;
  trace.push(`${Date.now()} step ${step} ${name}`);
  action?.();
  for (let waited = 0; action && waited < 3000 && !shown(from); waited += 2) await Bun.sleep(2);
  // A patch may take a second frame (the driver's commit after the press).
  if (name.startsWith("patch")) await Bun.sleep(150);
  trace.push(`${Date.now()} read ${step}`);
  const read = Bun.spawnSync(["python3", "-I", dump, APP]);
  trace.push(`${Date.now()} read ${step} done`);
  const file = `${outDir}/${String(step).padStart(2, "0")}-${name}.txt`;
  writeFileSync(file, read.stdout.toString() + read.stderr.toString());
  step += 1;
}

const scroll = (dy: number) => () => transport.simulate({ kind: "scroll", id: id("scroller"), dy });
const press = (testId: string) => () => transport.simulate({ kind: "click", id: id(testId) });

await after("start", null);
await after("scroll-40", scroll(40));
await after("scroll-40-again", scroll(40));
await after("scroll-far", scroll(700));
await after("patch-banner-grows", press("banner"));
await after("scroll-back-a-little", scroll(-120));
await after("patch-select", press("card:100"));
await after("patch-extra-row", press("more"));
await after("scroll-13", scroll(13));
await after("patch-banner-shrinks", press("banner"));
await after("patch-extra-row-goes", press("more"));
transport.simulate({ kind: "click", id: id("name") });
await Bun.sleep(200);
await after("patch-type", () => transport.simulate({ kind: "type", text: "ab" }));
await after("scroll-to-the-end", scroll(5000));
await after("scroll-to-the-start", scroll(-5000));
// Accessibility turned off and on again under the app (`run.sh`), as a
// screen reader quitting and starting does: the tree is whole again, and
// follows what moves after that.
const status = Number(process.env.A11Y_STATUS_PID);
if (status) {
  process.kill(status, "SIGUSR1");
  await Bun.sleep(700);
  await after("scroll-while-off", scroll(200));
  process.kill(status, "SIGUSR1");
  await Bun.sleep(1200);
  await after("on-again", null);
  await after("scroll-after-on-again", scroll(60));
}

if (tracePath) writeFileSync(tracePath, `${trace.join("\n")}\n`);
root.unmount();
transport.close();
display?.close();
for (const line of complaints) console.error(line);
const checked = complaints.some((line) => line.includes("access check"));
console.log(`${step} steps read into ${outDir}${checked ? "; the access check complained" : ""}`);
process.exit(checked ? 1 : 0);
