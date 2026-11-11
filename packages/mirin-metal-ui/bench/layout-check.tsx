/**
 * Layout equivalence between two hosts: drives the same app through the
 * same steps on each and compares every id'd node's painted bounds (the
 * simulation channel's `layout` query) after every step. For checking that
 * a renderer change (retained subtrees, a fork patch) lays out exactly what
 * the host before it did.
 *
 *   bun bench/layout-check.tsx <app> <host-a> <host-b> [--visible]
 *
 * `app` is `browser` (the example browser, ~900 nodes) or `grid` (a
 * 40×25 card grid like `@mirinjs/metal`'s stress bench). Exits non-zero
 * on any difference. Runs in an off-screen compositor unless `--visible`.
 */

import {
  type LayoutNode,
  type NativeEvent,
  render,
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
if (!app || !hostA || !hostB || !["browser", "grid"].includes(app)) {
  console.error("usage: bun bench/layout-check.tsx <browser|grid> <host-a> <host-b> [--visible]");
  process.exit(2);
}
const display = args.includes("--visible") ? null : await startHeadlessDisplay();
if (!display && !args.includes("--visible")) {
  console.error("no headless compositor; pass --visible to use the current display");
  process.exit(1);
}

function Card({ index }: { index: number }) {
  const [selected, setSelected] = useState(false);
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
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

type Step = { name: string; command: (nodeId: (testId: string) => string) => SimCommand };
const steps: Step[] =
  app === "grid"
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
        { name: "hover item", command: (id) => ({ kind: "move", id: id("example:button-demo") }) },
        { name: "button", command: (id) => ({ kind: "click", id: id("example:button-demo") }) },
        { name: "theme", command: (id) => ({ kind: "click", id: id("toggle-theme") }) },
        { name: "search", command: (id) => ({ kind: "click", id: id("search") }) },
        { name: "type", command: () => ({ kind: "type", text: "but" }) },
      ];

type Snapshot = Map<string, string>;

async function run(binary: string): Promise<Array<{ name: string; layout: Snapshot }>> {
  const transport = spawnNativeHost(binary, {
    title: "layout check",
    width: 1280,
    height: 800,
    env: { ...display?.env },
  });
  let layout: LayoutNode[] | null = null;
  transport.onEvent((event: NativeEvent) => {
    if (event.type === "layout") layout = event.nodes;
  });
  const root = render(
    app === "grid" ? (
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
    return new Map(
      nodes.map((node) => [node.id, `${node.x},${node.y} ${node.width}x${node.height}`]),
    );
  };
  await Bun.sleep(3000);
  const out = [{ name: "initial", layout: await snapshot() }];
  for (const step of steps) {
    transport.simulate(step.command(nodeId));
    // Several frames: the driver's answer, then whatever it settles into.
    await Bun.sleep(1500);
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
async function recorded(binary: string): Promise<Array<{ name: string; layout: Snapshot }>> {
  const path = `${process.env.TMPDIR ?? "/tmp"}/layout-check-${process.pid}-${Math.random()}.json`;
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      app as string,
      binary,
      "-",
      `--record=${path}`,
      ...args.filter((arg) => arg === "--visible"),
    ],
    { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...display?.env } },
  );
  await child.exited;
  const steps: Array<{ name: string; layout: Array<[string, string]> }> =
    await Bun.file(path).json();
  return steps.map((step) => ({ name: step.name, layout: new Map(step.layout) }));
}
const a = await recorded(hostA);
const b = await recorded(hostB);
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
  console.log(`${stepA.name.padEnd(12)} ${stepA.layout.size} nodes, ${differ} differ`);
  differences += differ;
}
console.log(differences === 0 ? "layouts identical" : `${differences} differences`);
process.exit(differences === 0 ? 0 : 1);
