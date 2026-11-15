/**
 * A field the app also writes loses no key when the two cross.
 *
 *   bun bench/field-crossing.tsx <host> [--rounds=40]
 *
 * A calculator's line: the person types in it, and a keypad's 7 writes it in
 * the app. Each round does both at once, in the two orders they can cross:
 *
 * - `click`: a click on 7 and "*6=" typed right after, as an agent sends
 *   them (Dashi's D124). The keys reach the field before or after the tree
 *   with the 7 does, as the machine has it; the line must read "7*6=".
 * - `write`: "*" typed into "5", and the app writes "57" before it has
 *   heard of the "*" (always a crossing); the line must read "57*".
 *
 * After each, one more key is typed: what the app then hears says what the
 * field held, so the two are compared, not only the app's side. Prints how
 * many rounds really crossed (a change the driver dropped) and exits
 * non-zero when any round ended with another text. A host from before
 * `baseHash` (no `"rebase":true` in its `protocol` line) fails it.
 *
 * Needs a Wayland compositor that presents, as the layout checks do:
 * `dashi-comp --backend winit --no-xwayland -c "bun bench/field-crossing.tsx <host>"`
 * with a `DASHI_COMP_SOCKET` of its own.
 */

import { useState } from "react";
import { type NativeEvent, render, spawnNativeHost, TextInput, View } from "../src/index.ts";

const args = Bun.argv.slice(2);
const [binary] = args.filter((arg) => !arg.startsWith("--"));
const rounds = Number(args.find((arg) => arg.startsWith("--rounds="))?.slice(9) ?? 40);
if (!binary || !Number.isInteger(rounds) || rounds < 1) {
  console.error("usage: bun bench/field-crossing.tsx <host> [--rounds=40]");
  process.exit(2);
}

/** The app's side: its line, and how the check writes it. */
const app = {
  line: "",
  heard: 0,
  set: (_next: { text: string; revision: number }): void => {},
  append: (_text: string): void => {},
};

function Calculator() {
  const [line, setLine] = useState({ text: "", revision: 0 });
  app.line = line.text;
  app.set = setLine;
  app.append = (text) => setLine((old) => ({ ...old, text: old.text + text }));
  return (
    <View style={{ flex: 1, padding: 12, gap: 12, backgroundColor: "#18181b" }}>
      <TextInput
        testID="line"
        autoFocus
        value={line.text}
        valueRevision={line.revision}
        onChangeText={(text) => {
          app.heard += 1;
          setLine((old) => ({ ...old, text }));
        }}
        style={{ height: 32, padding: 8, color: "#fafafa", backgroundColor: "#27272a" }}
      />
      <View
        testID="seven"
        onPress={() => app.append("7")}
        style={{ width: 48, height: 48, backgroundColor: "#3f3f46" }}
      />
    </View>
  );
}

const transport = spawnNativeHost(binary, {
  title: "field crossing",
  width: 320,
  height: 200,
  env: { MIRIN_METAL_CHECK: "1" },
});
let gone = false;
transport.onClose(() => {
  gone = true;
});
/** Everything the host said but its answers to `settle`, counted. */
let said = 0;
let changes = 0;
let rebases = false;
const waiting: Array<(event: NativeEvent) => void> = [];
transport.onEvent((event) => {
  if (event.type === "protocol") rebases = event.rebase === true;
  if (event.type === "settled") {
    waiting.shift()?.(event);
    return;
  }
  said += 1;
  if (event.type === "change") changes += 1;
});
const root = render(<Calculator />, transport);

/** Until the window has settled and the app has answered all it heard. */
async function settled(): Promise<void> {
  for (let quiet = 0; quiet < 2 && !gone; ) {
    const before = said;
    const answer = new Promise<NativeEvent>((resolve) => waiting.push(resolve));
    transport.simulate({ kind: "settle" });
    await Promise.race([answer, Bun.sleep(30_000)]);
    await Bun.sleep(0);
    quiet = said === before ? quiet + 1 : 0;
  }
}

let revision = 0;
/** The line starts over as `text`, in the app and in the field. */
async function start(text: string): Promise<void> {
  revision += 1;
  app.set({ text, revision });
  await settled();
}

interface Outcome {
  line: string;
  /** The line after one more key: the field's text and that key. */
  after: string;
  crossed: boolean;
}

async function round(kind: "click" | "write"): Promise<Outcome> {
  const field = root.nodeId("line") ?? "";
  await start(kind === "click" ? "" : "5");
  transport.simulate({ kind: "focus", id: field });
  await settled();
  const [heard, sent] = [app.heard, changes];
  if (kind === "click") {
    transport.simulate({ kind: "click", id: root.nodeId("seven") ?? "" });
    transport.simulate({ kind: "focus", id: field });
    transport.simulate({ kind: "type", text: "*6=" });
  } else {
    transport.simulate({ kind: "type", text: "*" });
    app.append("7");
  }
  await settled();
  const line = app.line;
  // A change the app never heard was typed on a text it had replaced.
  const crossed = changes - sent > app.heard - heard;
  transport.simulate({ kind: "type", text: "!" });
  await settled();
  return { line, after: app.line, crossed };
}

await settled();
const wanted = { click: "7*6=", write: "57*" };
const failures: string[] = [];
const crossed = { click: 0, write: 0 };
for (let index = 0; index < rounds && !gone; index += 1) {
  for (const kind of ["click", "write"] as const) {
    const outcome = await round(kind);
    if (outcome.crossed) crossed[kind] += 1;
    if (outcome.line !== wanted[kind] || outcome.after !== `${wanted[kind]}!`) {
      failures.push(
        `round ${index} ${kind}: the app has ${JSON.stringify(outcome.line)}, then ${JSON.stringify(outcome.after)}`,
      );
    }
  }
}
root.unmount();

for (const failure of failures.slice(0, 10)) console.log(failure);
console.log(
  `field-crossing: ${rounds} rounds of each, ${failures.length} wrong; crossed ${crossed.click} (click) and ${crossed.write} (write)${rebases ? "" : "; the host does not rebase"}${gone ? "; the host went away" : ""}`,
);
process.exit(failures.length === 0 && !gone ? 0 : 1);
