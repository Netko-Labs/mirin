/**
 * Layout equivalence between two hosts: drives the same app through the
 * same steps on each and compares every id'd node's painted bounds (the
 * simulation channel's `layout` query) after every step. For checking that
 * a renderer change (retained subtrees, a fork patch) lays out exactly what
 * the host before it did.
 *
 *   bun bench/layout-check.tsx <app> <host-a> <host-b> [--visible] [--scene]
 *     [--env-a=NAME=value] [--env-b=NAME=value]
 *
 * `app` is `browser` (the example browser, ~900 nodes), `grid` (a 40×25
 * card grid like `@mirinjs/metal`'s stress bench) or `scroll` (the grid in a
 * scroll view under a banner, scrolled, with clicks and pointer moves by
 * window coordinates: the node pressed or hovered is compared too). Exits
 * non-zero on any difference. Runs in an off-screen compositor unless
 * `--visible`.
 *
 * `--scene` also compares what each host drew after every step: a digest of
 * the frame's primitives and hitboxes, which a host traces with
 * `MIRIN_METAL_TRACE_SCENE=1` (hosts from before that have none). With
 * `--env-b=MIRIN_METAL_RETAIN=0` and the same host twice, that checks
 * retained subtrees draw what drawing everything does.
 */

import {
  type LayoutNode,
  type NativeEvent,
  render,
  ScrollView,
  type SimCommand,
  spawnNativeHost,
  startHeadlessDisplay,
  Text,
  TextInput,
  View,
} from "@mirinjs/metal";
import { useState } from "react";
import { Browser } from "../demo/browser.tsx";
import { ThemeProvider } from "../src/provider.tsx";

const args = Bun.argv.slice(2);
const [app, hostA, hostB] = args.filter((arg) => !arg.startsWith("--"));
if (!app || !hostA || !hostB || !["browser", "grid", "scroll"].includes(app)) {
  console.error(
    "usage: bun bench/layout-check.tsx <browser|grid|scroll> <host-a> <host-b> [--visible] [--scene]",
  );
  process.exit(2);
}
const scene = args.includes("--scene");
/** `--env-a=NAME=value` (or `-b`): the environment of that host alone. */
const hostEnv = (host: "a" | "b"): Record<string, string> =>
  Object.fromEntries(
    args
      .filter((arg) => arg.startsWith(`--env-${host}=`))
      .map((arg) => {
        const [name = "", ...value] = arg.slice(`--env-${host}=`.length).split("=");
        return [name, value.join("=")];
      }),
  );
const display = args.includes("--visible") ? null : await startHeadlessDisplay();
if (!display && !args.includes("--visible")) {
  console.error("no headless compositor; pass --visible to use the current display");
  process.exit(1);
}

function Card({ index, hovers = false }: { index: number; hovers?: boolean }) {
  const [selected, setSelected] = useState(false);
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
      onHoverChange={hovers ? () => {} : undefined}
      style={{
        width: 44,
        padding: 4,
        gap: 2,
        borderRadius: 6,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? "#3b82f6" : "#27272a",
        backgroundColor: selected ? "#1e3a8a" : "#18181b",
        hoverBackgroundColor: "#27272a",
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 9, color: "#a1a1aa" }}>#{index}</Text>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e" }} />
      </View>
      <Text style={{ fontSize: 11, color: "#f4f4f5" }}>
        {selected ? `${(index * 7919) % 1000} picked` : (index * 7919) % 1000}
      </Text>
    </View>
  );
}

function Grid() {
  const [query, setQuery] = useState("");
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          testID="query"
          value={query}
          onChangeText={setQuery}
          style={{ width: 240, height: 24, color: "#f4f4f5" }}
        />
        <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{query.length} chars</Text>
      </View>
      <View style={{ flex: 1, gap: 2, overflow: "hidden" }}>
        {Array.from({ length: 40 }, (_, row) => (
          <View key={row} style={{ flexDirection: "row", gap: 2, flexWrap: "wrap" }}>
            {Array.from({ length: 25 }, (_, col) => (
              <Card key={col} index={row * 25 + col} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

/** The grid in a scroll view, under a banner that grows when pressed. */
function Scrolled() {
  const [tall, setTall] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <Text style={{ color: "#f4f4f5", fontSize: 14 }}>scrolled</Text>
      <ScrollView testID="scroller" style={{ flex: 1, gap: 8 }}>
        <View
          testID="banner"
          onPress={() => setTall((value) => !value)}
          style={{ height: tall ? 47 : 12, backgroundColor: "#3f3f46" }}
        />
        <View style={{ gap: 2 }}>
          {Array.from({ length: 60 }, (_, row) => (
            <View key={row} style={{ flexDirection: "row", gap: 2 }}>
              {Array.from({ length: 25 }, (_, col) => (
                // Every third row hears hovers: it is never left undrawn.
                <Card key={col} index={row * 25 + col} hovers={row % 3 === 1} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

type Step = {
  name: string;
  /** `at`: a point inside the border of the node with a test id, as last laid out. */
  command: (
    nodeId: (testId: string) => string,
    at: (testId: string) => { x: number; y: number },
  ) => SimCommand;
};
const scroll = (dy: number): Step => ({
  name: `scroll ${dy}`,
  command: (id) => ({ kind: "scroll", id: id("scroller"), dy }),
});
/** A press by window coordinates on a card's edge: on whichever node is drawn there. */
const press = (index: number): Step => ({
  name: `press at ${index}`,
  command: (_, at) => ({ kind: "click", ...at(`card:${index}`) }),
});
/** A pointer move by window coordinates onto a card. */
const point = (index: number): Step => ({
  name: `move to ${index}`,
  command: (_, at) => ({ kind: "move", ...at(`card:${index}`) }),
});
const steps: Step[] =
  app === "scroll"
    ? [
        scroll(40),
        scroll(40),
        scroll(13),
        // Presses and pointer moves by window coordinates: on whichever
        // card is drawn there after the scroll (rows 1, 4, 7… hear hovers).
        press(130),
        point(160),
        point(110),
        scroll(700),
        press(480),
        point(560),
        // What is above the rows grows: every row moves.
        { name: "grow", command: (id) => ({ kind: "click", id: id("banner") }) },
        point(485),
        press(510),
        scroll(-320),
        press(300),
        point(410),
        { name: "shrink", command: (id) => ({ kind: "click", id: id("banner") }) },
        // Half a pixel: nothing lands on whole pixels.
        scroll(60.5),
        press(330),
        scroll(19.5),
        scroll(5000),
        point(1410),
        press(1420),
        scroll(-5000),
        point(35),
        { name: "move off", command: () => ({ kind: "move", x: 2, y: 2 }) },
      ]
    : app === "grid"
      ? [
          // Selecting widens a card's border and lengthens its text: its row
          // grows and every row below moves.
          { name: "select 3", command: (id) => ({ kind: "click", id: id("card:3") }) },
          { name: "select 260", command: (id) => ({ kind: "click", id: id("card:260") }) },
          { name: "hover 30", command: (id) => ({ kind: "move", id: id("card:30") }) },
          { name: "hover off", command: () => ({ kind: "move", x: 2, y: 2 }) },
          { name: "unselect 3", command: (id) => ({ kind: "click", id: id("card:3") }) },
          { name: "focus query", command: (id) => ({ kind: "click", id: id("query") }) },
          { name: "type", command: () => ({ kind: "type", text: "abc" }) },
        ]
      : [
          { name: "badge", command: (id) => ({ kind: "click", id: id("example:badge-demo") }) },
          { name: "card", command: (id) => ({ kind: "click", id: id("example:card-demo") }) },
          {
            name: "accordion",
            command: (id) => ({ kind: "click", id: id("example:accordion-demo") }),
          },
          {
            name: "scroll list",
            command: (id) => ({ kind: "scroll", id: id("example-list"), dy: 300 }),
          },
          {
            name: "hover item",
            command: (id) => ({ kind: "move", id: id("example:button-demo") }),
          },
          { name: "button", command: (id) => ({ kind: "click", id: id("example:button-demo") }) },
          { name: "theme", command: (id) => ({ kind: "click", id: id("toggle-theme") }) },
          { name: "search", command: (id) => ({ kind: "click", id: id("search") }) },
          { name: "type", command: () => ({ kind: "type", text: "but" }) },
        ];

type Snapshot = Map<string, string>;

async function run(binary: string): Promise<Array<{ name: string; layout: Snapshot }>> {
  // What the last frame drew (`--scene`), from the host's trace.
  let drew = "";
  const transport = spawnNativeHost(binary, {
    title: "layout check",
    width: 1280,
    height: 800,
    env: {
      ...display?.env,
      ...hostEnv("a"),
      ...(scene ? { MIRIN_METAL_TRACE: "1", MIRIN_METAL_TRACE_SCENE: "1" } : {}),
    },
    onStderr(line) {
      const digest = line.match(/^\[mirin-metal trace\] [\d.]+ scene ([0-9a-f]+)$/)?.[1];
      if (digest) drew = digest;
      else if (!line.startsWith("[mirin-metal trace]")) console.error(line);
    },
  });
  let layout: LayoutNode[] | null = null;
  // The nodes pressed and hovered since the last snapshot, in order.
  let heard: string[] = [];
  transport.onEvent((event: NativeEvent) => {
    if (event.type === "layout") layout = event.nodes;
    if (event.type === "press") heard.push(`press ${event.nodeId}`);
    if (event.type === "hover") heard.push(`hover ${event.nodeId} ${event.hovered}`);
  });
  const root = render(
    app === "scroll" ? (
      <Scrolled />
    ) : app === "grid" ? (
      <Grid />
    ) : (
      <ThemeProvider>
        <Browser initial="button-demo" />
      </ThemeProvider>
    ),
    transport,
  );
  const nodeId = (testId: string): string => {
    const id = root.nodeId(testId);
    if (!id) throw new Error(`no node ${testId}`);
    return id;
  };
  const snapshot = async (): Promise<Snapshot> => {
    layout = null;
    transport.simulate({ kind: "layout" });
    for (let waited = 0; layout === null && waited < 3000; waited += 20) await Bun.sleep(20);
    const nodes: LayoutNode[] = layout ?? [];
    const snapshot = new Map(
      nodes.map((node) => [node.id, `${node.x},${node.y} ${node.width}x${node.height}`]),
    );
    snapshot.set("(heard)", heard.join(", "));
    heard = [];
    if (scene) snapshot.set("(drew)", drew);
    return snapshot;
  };
  await Bun.sleep(3000);
  const out = [{ name: "initial", layout: await snapshot() }];
  for (const step of steps) {
    const laid = out.at(-1)?.layout;
    const at = (testId: string): { x: number; y: number } => {
      const [x = 0, y = 0] = (laid?.get(nodeId(testId)) ?? "").split(/[, ]/).map(Number);
      return { x: x + 2, y: y + 2 };
    };
    transport.simulate(step.command(nodeId, at));
    // Several frames: the driver's answer, then whatever it settles into
    // (a scroll bar fades for over a second, at a nested compositor's pace
    // of a frame a second).
    await Bun.sleep(scene ? 3500 : 1500);
    out.push({ name: step.name, layout: await snapshot() });
  }
  root.unmount();
  transport.close();
  return out;
}

// Each host runs in a process of its own, so node ids (a counter in the
// renderer) line up between the two.
const record = args.find((arg) => arg.startsWith("--record="))?.slice("--record=".length);
if (record) {
  const steps = await run(hostA);
  display?.close();
  await Bun.write(
    record,
    JSON.stringify(steps.map((step) => ({ name: step.name, layout: [...step.layout] }))),
  );
  process.exit(0);
}
async function recorded(
  binary: string,
  host: "a" | "b",
): Promise<Array<{ name: string; layout: Snapshot }>> {
  const path = `${process.env.TMPDIR ?? "/tmp"}/layout-check-${process.pid}-${Math.random()}.json`;
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      app as string,
      binary,
      "-",
      `--record=${path}`,
      ...args.filter((arg) => arg === "--visible" || arg === "--scene"),
      // The child runs it as its first host.
      ...Object.entries(hostEnv(host)).map(([name, value]) => `--env-a=${name}=${value}`),
    ],
    { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...display?.env } },
  );
  await child.exited;
  const steps: Array<{ name: string; layout: Array<[string, string]> }> =
    await Bun.file(path).json();
  return steps.map((step) => ({ name: step.name, layout: new Map(step.layout) }));
}
const a = await recorded(hostA, "a");
const b = await recorded(hostB, "b");
display?.close();
let differences = 0;
for (const [index, stepA] of a.entries()) {
  const stepB = b[index];
  if (!stepB) continue;
  const ids = new Set([...stepA.layout.keys(), ...stepB.layout.keys()]);
  let differ = 0;
  for (const id of ids) {
    const [left, right] = [stepA.layout.get(id), stepB.layout.get(id)];
    if (left !== right) {
      if (differ < 5)
        console.log(`  ${stepA.name}: node ${id}: ${left ?? "absent"} vs ${right ?? "absent"}`);
      differ += 1;
    }
  }
  console.log(
    `${stepA.name.padEnd(14)} ${stepA.layout.size - 1 - Number(scene)} nodes, ${differ} differ`,
  );
  differences += differ;
}
console.log(differences === 0 ? "layouts identical" : `${differences} differences`);
process.exit(differences === 0 ? 0 : 1);
