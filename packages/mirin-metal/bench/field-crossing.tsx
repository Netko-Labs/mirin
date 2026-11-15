/**
 * A field the app also writes loses no key when the two cross, and its
 * caret stays with what was typed.
 *
 *   bun bench/field-crossing.tsx <host> [--rounds=40]
 *
 * A calculator's line: the person types in it, and a keypad's 7 writes it in
 * the app, at the app's caret. Each round does both at once, in the two
 * orders they can cross:
 *
 * - `click`: a click on 7 and "*6=" typed right after, as an agent sends
 *   them (Dashi's D124). The keys reach the field before or after the tree
 *   with the 7 does, as the machine has it; the line must read "7*6=".
 * - `write`: "*" typed into "5", and the app writes "57" before it has
 *   heard of the "*" (always a crossing); the line must read "57*".
 *
 * - `refuse`: "12x+3" typed at once into a line that takes no "x": the app
 *   hears "12x" and writes "12" again (a new `valueRevision`) while "+3" is
 *   already in the field; the line must read "12+3" (Dashi's D129: the
 *   reset used to drop the "+3").
 *
 * And each of them three ways: the app saying no `selection`, saying its
 * caret with every text (at the end of the line, after what the keypad
 * wrote), and with the caret inside the line ("12", the caret after the 1:
 * the keypad's text and the keys both go there). The app's caret is made in
 * the text it knows, before it hears of the keys: a field that took it
 * would type the next key in front of them (Dashi's D129). In those rounds
 * the keypad's key is "sin(", four characters where three keys are typed,
 * so the app's caret is never one the field reported on its way (a host
 * takes that for its own, late, and would pass by chance).
 *
 * One more key ("!") is typed the moment the field says it took the app's
 * write (its first change made on that text), before the app has heard of
 * it and can say its caret again: an agent's keys do not wait for the app
 * either. It must land after the keys typed before it. What the app then
 * hears says what the field held and where its caret was, so the two are
 * compared, not only the app's side. Prints how many rounds really crossed
 * (a change the driver dropped) and exits non-zero when any round ended
 * with another text, or never came to rest. A host from before `baseHash`
 * (no `"rebase":true` in its `protocol` line) fails it, and one from
 * before a selection's `textHash` (no `"selectionHash":true`) fails the
 * rounds with a caret: the key lands in front ("sin(!*6="), and then the
 * app's caret and the field's go on answering each other. One from before
 * `"revisionRebase":true` fails the `refuse` rounds.
 *
 * Needs a Wayland compositor that presents, as the layout checks do:
 * `dashi-comp --backend winit --no-xwayland -c "bun bench/field-crossing.tsx <host>"`
 * with a `DASHI_COMP_SOCKET` of its own.
 */

import { useState } from "react";
import {
  type NativeEvent,
  render,
  spawnNativeHost,
  TextInput,
  textHash,
  View,
} from "../src/index.ts";

const args = Bun.argv.slice(2);
const [binary] = args.filter((arg) => !arg.startsWith("--"));
const rounds = Number(args.find((arg) => arg.startsWith("--rounds="))?.slice(9) ?? 40);
if (!binary || !Number.isInteger(rounds) || rounds < 1) {
  console.error("usage: bun bench/field-crossing.tsx <host> [--rounds=40]");
  process.exit(2);
}

interface Line {
  text: string;
  revision: number;
  /** The app's caret, as it works it out from what it hears. */
  caret: number;
  /** Whether the app says its caret (`selection`). */
  says: boolean;
}

/** The app's side: its line, and how the check writes it. */
const app = {
  line: "",
  heard: 0,
  /** The line starts over (a new revision). */
  set: (_next: Omit<Line, "revision">): void => {},
  /** A keypad key: its text typed at the app's caret. */
  key: (_text: string): void => {},
};

/** Where the caret is after `old` was edited into `text`: after what was put in. */
function caretAfter(old: string, text: string): number {
  let tail = 0;
  const most = Math.min(old.length, text.length);
  while (tail < most && old[old.length - 1 - tail] === text[text.length - 1 - tail]) tail += 1;
  return text.length - tail;
}

function Calculator() {
  const [line, setLine] = useState<Line>({ text: "", revision: 0, caret: 0, says: false });
  app.line = line.text;
  app.set = (next) => setLine((old) => ({ ...next, revision: old.revision + 1 }));
  app.key = (text) =>
    setLine((old) => ({
      ...old,
      text: old.text.slice(0, old.caret) + text + old.text.slice(old.caret),
      caret: old.caret + text.length,
    }));
  return (
    <View style={{ flex: 1, padding: 12, gap: 12, backgroundColor: "#18181b" }}>
      <TextInput
        testID="line"
        autoFocus
        value={line.text}
        valueRevision={line.revision}
        selection={line.says ? { start: line.caret, end: line.caret } : undefined}
        onChangeText={(text) => {
          app.heard += 1;
          // The line takes no "x": its text without it is written again.
          const kept = text.replaceAll("x", "");
          setLine((old) => ({
            ...old,
            text: kept,
            revision: old.revision + (kept === text ? 0 : 1),
            caret: kept === old.text ? old.caret : caretAfter(old.text, kept),
          }));
        }}
        onSelectionChange={({ end }) => setLine((old) => ({ ...old, caret: end }))}
        style={{ height: 32, padding: 8, color: "#fafafa", backgroundColor: "#27272a" }}
      />
      {["7", "sin("].map((key) => (
        <View
          key={key}
          testID={key}
          onPress={() => app.key(key)}
          style={{ width: 48, height: 48, backgroundColor: "#3f3f46" }}
        />
      ))}
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
let namesSelections = false;
let rebasesRevisions = false;
const waiting: Array<(event: NativeEvent) => void> = [];
/** The hash of the text the app is writing: the round's last key is typed at the first change made on it. */
let lastKeyOn: number | null = null;
transport.onEvent((event) => {
  if (event.type === "protocol") {
    rebases = event.rebase === true;
    namesSelections = event.selectionHash === true;
    rebasesRevisions = event.revisionRebase === true;
  }
  if (event.type === "settled") {
    waiting.shift()?.(event);
    return;
  }
  said += 1;
  if (event.type !== "change") return;
  changes += 1;
  // Heard here before `render` hears it (this listener came first), so the
  // key goes to the field ahead of whatever the app answers.
  // (In a `refuse` round the field also typed its "x" on that text, before.)
  const onWrite = event.baseHash !== undefined && event.baseHash === lastKeyOn;
  if (onWrite && !event.value.includes("x")) {
    lastKeyOn = null;
    transport.simulate({ kind: "type", text: "!" });
  }
});
const root = render(<Calculator />, transport);

/** How long a round may take to come to rest. */
const REST_MS = 20_000;
/** A round never came to rest: the app and the field kept answering each other. */
let restless = false;

/** Until the window has settled and the app has answered all it heard. */
async function settled(): Promise<void> {
  const began = Date.now();
  for (let quiet = 0; quiet < 2 && !gone && !restless; ) {
    const before = said;
    const answer = new Promise<NativeEvent>((resolve) => waiting.push(resolve));
    transport.simulate({ kind: "settle" });
    await Promise.race([answer, Bun.sleep(30_000)]);
    await Bun.sleep(0);
    quiet = said === before ? quiet + 1 : 0;
    restless = Date.now() - began > REST_MS;
  }
}

type Kind = "click" | "write" | "refuse";
/** What the app says of its caret: nothing, or where it is, at the line's end or inside it. */
type Caret = "unsaid" | "end" | "inside";

/** The line starts over as `text` with the caret at `caret`, in the app and in the field. */
async function start(text: string, caret: number, says: boolean): Promise<void> {
  app.set({ text, caret, says });
  await settled();
}

interface Outcome {
  /** The app's line when all is settled: the field's text with the last key at its caret. */
  line: string;
  crossed: boolean;
}

/**
 * What each round starts from (the caret at `at`), what the app writes at
 * its caret (the keypad's key, or the keys it takes of those typed), and
 * what the line must read at its end.
 */
interface Round {
  from: string;
  at: number;
  key: string;
  line: string;
}

const ROUNDS: Record<Kind, Record<Caret, Round>> = {
  click: {
    unsaid: { from: "", at: 0, key: "7", line: "7*6=!" },
    end: { from: "", at: 0, key: "sin(", line: "sin(*6=!" },
    inside: { from: "12", at: 1, key: "sin(", line: "1sin(*6=!2" },
  },
  write: {
    unsaid: { from: "5", at: 1, key: "7", line: "57*!" },
    end: { from: "5", at: 1, key: "sin(", line: "5sin(*!" },
    inside: { from: "12", at: 1, key: "sin(", line: "1sin(*!2" },
  },
  refuse: {
    unsaid: { from: "", at: 0, key: "12", line: "12+3!" },
    end: { from: "", at: 0, key: "12", line: "12+3!" },
    inside: { from: "98", at: 1, key: "12", line: "912+3!8" },
  },
};

async function round(kind: Kind, caret: Caret): Promise<Outcome> {
  const field = root.nodeId("line") ?? "";
  const { from, at, key } = ROUNDS[kind][caret];
  await start(from, at, caret !== "unsaid");
  transport.simulate({ kind: "focus", id: field });
  await settled();
  const [heard, sent] = [app.heard, changes];
  lastKeyOn = textHash(from.slice(0, at) + key + from.slice(at));
  if (kind === "click") {
    transport.simulate({ kind: "click", id: root.nodeId(key) ?? "" });
    transport.simulate({ kind: "focus", id: field });
    transport.simulate({ kind: "type", text: "*6=" });
  } else if (kind === "write") {
    transport.simulate({ kind: "type", text: "*" });
    app.key(key);
  } else {
    transport.simulate({ kind: "type", text: "12x+3" });
  }
  await settled();
  lastKeyOn = null;
  // A change the app never heard was typed on a text it had replaced.
  return { line: app.line, crossed: changes - sent > app.heard - heard };
}

await settled();
const failures: string[] = [];
const kinds: Kind[] = ["click", "write", "refuse"];
const carets: Caret[] = ["unsaid", "end", "inside"];
const crossed = Object.fromEntries(
  kinds.flatMap((kind) => carets.map((caret) => [`${kind} ${caret}`, 0])),
);
for (let index = 0; index < rounds && !gone && !restless; index += 1) {
  for (const kind of kinds) {
    for (const caret of carets) {
      if (gone || restless) break;
      const outcome = await round(kind, caret);
      if (outcome.crossed) crossed[`${kind} ${caret}`] = (crossed[`${kind} ${caret}`] ?? 0) + 1;
      const wanted = ROUNDS[kind][caret].line;
      if (outcome.line !== wanted) {
        failures.push(
          `round ${index} ${kind}, caret ${caret}: the app has ${JSON.stringify(outcome.line)}, not ${JSON.stringify(wanted)}`,
        );
      }
    }
  }
}
root.unmount();

for (const failure of failures.slice(0, 10)) console.log(failure);
const crossings = Object.entries(crossed)
  .map(([name, count]) => `${count} (${name})`)
  .join(", ");
console.log(
  `field-crossing: ${rounds} rounds of each, ${failures.length} wrong; crossed ${crossings}${rebases ? "" : "; the host does not rebase"}${namesSelections ? "" : "; the host takes no selection's text"}${rebasesRevisions ? "" : "; the host resets on a new revision"}${restless ? "; a round never came to rest" : ""}${gone ? "; the host went away" : ""}`,
);
process.exit(failures.length === 0 && !gone && !restless ? 0 : 1);
