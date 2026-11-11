import { describe, expect, test } from "bun:test";
import { createElement, Fragment, memo, type ReactNode, useState } from "react";
import { Text, TextInput, View } from "../src/components.ts";
import { HOST_WORD_MS, markAnnounces } from "../src/lib/handshake.ts";
import { createPortal, render } from "../src/render.ts";
import type { NativeEvent, NativeRoot, NativeTransport } from "../src/types.ts";

/** A JSON tree node as the host keeps it. */
interface Node {
  type: string;
  props: Record<string, unknown> & { id?: string };
  children?: Array<Node | string>;
}

type Op =
  | { op: "insert"; parent: string; before?: string; node: Node }
  | { op: "move"; id: string; parent: string; before?: string }
  | { op: "remove"; id: string }
  | { op: "set"; id: string; node: Node };

/**
 * A stand-in host: it announces patches, keeps the tree, and applies each
 * patch as crates/mirin-metal `patch/` does, failing as loudly.
 */
class PatchingHost implements NativeTransport {
  tree: Node | null = null;
  lines: string[] = [];
  private listeners: Array<(event: NativeEvent) => void> = [];

  send(line: string): void {
    this.lines.push(line);
    const value = JSON.parse(line) as Node | { patch: Op[] };
    if ("patch" in value) {
      if (!this.tree) throw new Error("a patch before any tree");
      for (const op of value.patch) apply(this.tree, op);
    } else this.tree = value;
  }
  onEvent(listener: (event: NativeEvent) => void): void {
    this.listeners.push(listener);
    // As the host does when it starts.
    listener({ type: "protocol", nodeId: "root", patches: 1 });
  }
  emit(event: NativeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  onClose(): void {}
  simulate(): void {}
  close(): void {}
}

function find(node: Node, id: string, parent: Node | null = null): [Node, Node | null] | null {
  if (node.props.id === id) return [node, parent];
  for (const child of node.children ?? []) {
    if (typeof child === "string") continue;
    const found = find(child, id, node);
    if (found) return found;
  }
  return null;
}

function at(tree: Node, id: string): [Node, Node | null] {
  const found = find(tree, id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

function childIndex(parent: Node, id: string): number {
  const index = (parent.children ?? []).findIndex(
    (child) => typeof child !== "string" && child.props.id === id,
  );
  if (index < 0) throw new Error(`${id} is not a child of ${parent.props.id}`);
  return index;
}

function apply(tree: Node, op: Op): void {
  switch (op.op) {
    case "insert": {
      const [parent] = at(tree, op.parent);
      if (find(tree, op.node.props.id ?? "")) throw new Error(`${op.node.props.id} already in`);
      const children = parent.children ?? [];
      children.splice(op.before ? childIndex(parent, op.before) : children.length, 0, op.node);
      return;
    }
    case "remove": {
      const [, parent] = at(tree, op.id);
      if (!parent) throw new Error("the root stays");
      parent.children?.splice(childIndex(parent, op.id), 1);
      return;
    }
    case "move": {
      const [node, from] = at(tree, op.id);
      if (!from) throw new Error("the root stays");
      from.children?.splice(childIndex(from, op.id), 1);
      const [parent] = at(tree, op.parent);
      const children = parent.children ?? [];
      children.splice(op.before ? childIndex(parent, op.before) : children.length, 0, node);
      return;
    }
    case "set": {
      const [node] = at(tree, op.id);
      if (node.type !== op.node.type) throw new Error("a set keeps the type");
      if (op.node.children && node.type === "view") throw new Error("a view's children aren't set");
      node.props = op.node.props;
      if (node.type !== "view") node.children = op.node.children;
    }
  }
}

const nextCommit = () => Bun.sleep(25);

/** Mount `element`, then check the host's patched tree is the whole tree after every step. */
async function mounted(element: ReactNode): Promise<{
  host: PatchingHost;
  root: NativeRoot;
  step(change: () => void): Promise<string>;
}> {
  const host = new PatchingHost();
  const root = render(element, host);
  await nextCommit();
  expect(host.tree).not.toBeNull();
  expect(JSON.stringify(host.tree)).toBe(root.lastTree() ?? "");
  return {
    host,
    root,
    async step(change) {
      const sent = host.lines.length;
      change();
      await nextCommit();
      // What the host built from patches is what a whole tree would say.
      expect(JSON.stringify(host.tree)).toBe(root.lastTree() ?? "");
      return host.lines.slice(sent).join("\n");
    },
  };
}

/** A setter the test calls from outside React. */
function control<T>(initial: T): { use(): T; set(value: T): void } {
  let setter: ((value: T) => void) | null = null;
  return {
    use() {
      const [value, set] = useState(initial);
      setter = set;
      return value;
    },
    set(value) {
      setter?.(value);
    },
  };
}

describe("tree patches", () => {
  test("after one whole tree, a style change is one set", async () => {
    const color = control("#111111");
    function App() {
      const background = color.use();
      return createElement(
        View,
        { style: { padding: 4 } },
        createElement(View, { testID: "card", style: { backgroundColor: background } }),
        createElement(Text, { style: { color: "#ffffff" } }, "label"),
      );
    }
    const { host, root, step } = await mounted(createElement(App));
    // The whole tree names every node, text included.
    const whole = host.lines.at(-1) ?? "";
    expect(whole.startsWith('{"type":"view"')).toBe(true);
    expect(whole).toContain('"type":"text","props":{"id":');
    const line = await step(() => color.set("#222222"));
    const card = root.nodeId("card");
    expect(JSON.parse(line)).toEqual({
      patch: [
        {
          op: "set",
          id: card,
          node: { type: "view", props: { id: card, background: "#222222" } },
        },
      ],
    });
    // Nothing changed: nothing is sent.
    expect(await step(() => color.set("#222222"))).toBe("");
    root.unmount();
  });

  test("text changes set the text node, in a Text and directly in a view", async () => {
    const label = control("one");
    function App() {
      const text = label.use();
      return createElement(
        View,
        { textStyle: { color: text === "two" ? "#ff0000" : "#00ff00" } },
        createElement(Text, null, "count: ", text),
        text,
      );
    }
    const { step } = await mounted(createElement(App));
    const line = JSON.parse(await step(() => label.set("two"))) as { patch: Op[] };
    const sets = line.patch.filter((op): op is Op & { op: "set" } => op.op === "set");
    // textStyle is not sent with the view; only its strings change.
    expect(sets.map((op) => op.node.type)).toEqual(["text", "text"]);
    const strings = sets.filter((op) => op.node.type === "text").map((op) => op.node.children);
    expect(strings).toContainEqual(["count: ", "two"]);
    // A string placed in a view is drawn in its textStyle, so it changes with it.
    expect(sets).toContainEqual(
      expect.objectContaining({
        node: expect.objectContaining({ props: expect.objectContaining({ color: "#ff0000" }) }),
      }),
    );
  });

  test("keyed reorders move nodes; new and removed rows insert and remove", async () => {
    const rows = control(["a", "b", "c", "d"]);
    function App() {
      const keys = rows.use();
      return createElement(
        View,
        { testID: "list" },
        keys.map((key) =>
          createElement(View, { key, testID: `row:${key}` }, createElement(Text, null, key)),
        ),
      );
    }
    const { step } = await mounted(createElement(App));
    const reorder = JSON.parse(await step(() => rows.set(["d", "a", "c", "b"]))) as {
      patch: Op[];
    };
    expect(reorder.patch.every((op) => op.op === "move")).toBe(true);
    const churn = JSON.parse(await step(() => rows.set(["e", "a", "b", "f"]))) as {
      patch: Op[];
    };
    expect(churn.patch.filter((op) => op.op === "insert")).toHaveLength(2);
    expect(churn.patch.filter((op) => op.op === "remove")).toHaveLength(2);
    // Inserted subtrees go whole; nothing inside them is set separately.
    expect(churn.patch.filter((op) => op.op === "set")).toHaveLength(0);
    await step(() => rows.set([]));
    await step(() => rows.set(["x", "y"]));
  });

  test("a long list changed every way keeps the host's order the driver's", async () => {
    const keys = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `k${from + index}`);
    const rows = control(keys(0, 60));
    function App() {
      const shown = rows.use();
      return createElement(
        View,
        { testID: "list" },
        shown.map((key) => createElement(View, { key }, createElement(Text, null, key))),
      );
    }
    const { step, host } = await mounted(createElement(App));
    const order = () =>
      ((host.tree?.children ?? []) as Node[]).map((row) => {
        const text = row.children?.[0] as Node;
        return String(text.children?.[0]);
      });
    const base = keys(0, 60);
    const shuffled = [...base];
    let seed = 7;
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const other = seed % (index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other] as string, shuffled[index] as string];
    }
    const swapped = [...base];
    [swapped[5], swapped[50]] = [swapped[50] as string, swapped[5] as string];
    const orders: string[][] = [
      [...base].reverse(),
      base,
      swapped,
      shuffled,
      [...base.slice(1), base[0] as string],
      // Many rows before the old ones, between them, and after.
      [...keys(100, 40), ...base],
      [...base.slice(0, 30), ...keys(200, 40), ...base.slice(30)],
      [...base, ...keys(300, 40)],
      // Every other row gone, then rows gone and new at once, in a new order.
      base.filter((_, index) => index % 2 === 0),
      [...keys(400, 10), ...[...base].reverse().filter((_, index) => index % 3 !== 0)],
      [],
      base,
    ];
    for (const next of orders) {
      await step(() => rows.set(next));
      expect(order()).toEqual(next);
    }
  });

  test("a reorder is sent in the fewest moves, whatever React moved", async () => {
    const keys = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `k${from + index}`);
    const rows = control(keys(0, 200));
    const Row = memo(function Row({ label }: { label: string }) {
      return createElement(View, null, createElement(Text, null, label));
    });
    function App() {
      return createElement(
        View,
        { testID: "list" },
        rows.use().map((key) => createElement(Row, { key, label: key })),
      );
    }
    const { step, host } = await mounted(createElement(App));
    const order = () =>
      ((host.tree?.children ?? []) as Node[]).map((row) => {
        const text = row.children?.[0] as Node;
        return String(text.children?.[0]);
      });
    const ops = async (next: string[]): Promise<Op[]> => {
      const line = await step(() => rows.set(next));
      expect(order()).toEqual(next);
      return (JSON.parse(line) as { patch: Op[] }).patch;
    };
    const base = keys(0, 200);
    // React places all 190 rows between the two it swaps; two moves say it.
    const swapped = [...base];
    [swapped[5], swapped[195]] = [swapped[195] as string, swapped[5] as string];
    expect((await ops(swapped)).map((op) => op.op)).toEqual(["move", "move"]);
    expect((await ops(base)).map((op) => op.op)).toEqual(["move", "move"]);
    // The last row first: React moves the other 199.
    expect(await ops([base[199] as string, ...base.slice(0, 199)])).toHaveLength(1);
    expect(await ops(base)).toHaveLength(1);
    // Reversed: every row but one moves, each to the end (no sibling to find).
    const reversed = await ops([...base].reverse());
    expect(reversed).toHaveLength(199);
    expect(reversed.every((op) => op.op === "move" && op.before === undefined)).toBe(true);
    await ops(base);
    // Moves beside new and removed rows, in one commit.
    const mixed = [...keys(500, 3), ...swapped.filter((_, index) => index % 50 !== 1), "k600"];
    const sent = await ops(mixed);
    expect(sent.filter((op) => op.op === "move")).toHaveLength(2);
    expect(sent.filter((op) => op.op === "insert")).toHaveLength(4);
    expect(sent.filter((op) => op.op === "remove")).toHaveLength(4);
    await ops([...mixed].reverse());
    await ops(base);
  });

  test("conditional subtrees mount and unmount; fields follow their value", async () => {
    const open = control(false);
    function App() {
      const shown = open.use();
      const [value, setValue] = useState("");
      return createElement(
        View,
        null,
        shown
          ? createElement(
              View,
              { testID: "panel" },
              createElement(TextInput, { testID: "field", value, onChangeText: setValue }),
              createElement(Text, null, value.length),
            )
          : null,
        createElement(Text, null, "footer"),
      );
    }
    const { host, root, step } = await mounted(createElement(App));
    const insert = JSON.parse(await step(() => open.set(true))) as { patch: Op[] };
    expect(insert.patch.map((op) => op.op)).toEqual(["insert"]);
    const field = root.nodeId("field") ?? "";
    const typed = await step(() => host.emit({ type: "change", nodeId: field, value: "hello" }));
    const ops = (JSON.parse(typed) as { patch: Op[] }).patch;
    expect(ops).toContainEqual({
      op: "set",
      id: field,
      node: { type: "input", props: { id: field, value: "hello", onChange: true } },
    });
    const removed = JSON.parse(await step(() => open.set(false))) as { patch: Op[] };
    expect(removed.patch.map((op) => op.op)).toEqual(["remove"]);
    expect(root.nodeId("field")).toBeUndefined();
    root.unmount();
  });

  test("a portal into another mounted view is an insert there", async () => {
    const shown = control(false);
    function App() {
      const [layer, setLayer] = useState<unknown>(null);
      const open = shown.use();
      return createElement(
        View,
        null,
        createElement(
          View,
          { testID: "content" },
          layer && open
            ? createPortal(
                createElement(View, { testID: "menu" }, createElement(Text, null, "Menu")),
                layer,
              )
            : null,
        ),
        createElement(View, { ref: setLayer, testID: "layer" } as never),
      );
    }
    const { root, step } = await mounted(createElement(App));
    const opened = JSON.parse(await step(() => shown.set(true))) as { patch: Op[] };
    expect(opened.patch).toEqual([
      expect.objectContaining({ op: "insert", parent: root.nodeId("layer") }),
    ]);
    await step(() => shown.set(false));
  });

  test("events reach the handlers of a node's newest props", async () => {
    const pressed: string[] = [];
    const which = control("first");
    function App() {
      const name = which.use();
      return createElement(View, {
        testID: "button",
        onPress: () => pressed.push(name),
      });
    }
    const { host, root, step } = await mounted(createElement(App));
    const button = root.nodeId("button") ?? "";
    // Only the handler changed: nothing to send, yet the press reaches it.
    expect(await step(() => which.set("second"))).toBe("");
    host.emit({ type: "press", nodeId: button });
    expect(pressed).toEqual(["second"]);
  });

  test("a resync sends the whole tree again; a new root is a whole tree", async () => {
    const swap = control(false);
    function App() {
      const other = swap.use();
      return other
        ? createElement(Text, null, "other root")
        : createElement(View, null, createElement(Text, null, "root"));
    }
    const { host, step } = await mounted(createElement(Fragment, null, createElement(App)));
    const before = host.lines.length;
    host.emit({ type: "resync", nodeId: "root", reason: "test" });
    expect(host.lines.length).toBe(before + 1);
    expect(host.lines.at(-1)?.startsWith('{"type":"view"')).toBe(true);
    const line = await step(() => swap.set(true));
    expect(line.startsWith('{"type":"text"')).toBe(true);
  });
});

describe("a host that says its protocol first", () => {
  /** A transport like `spawnNativeHost`'s: its host's word comes later, or never. */
  function announcing(sent: string[]): NativeTransport & { emit(event: NativeEvent): void } {
    const listeners: Array<(event: NativeEvent) => void> = [];
    return markAnnounces({
      send: (line: string) => {
        sent.push(line);
      },
      onEvent(listener: (event: NativeEvent) => void) {
        listeners.push(listener);
      },
      emit(event: NativeEvent) {
        for (const listener of listeners) listener(event);
      },
      onClose() {},
      simulate() {},
      close() {},
    });
  }

  test("gets the first tree once, with ids, when it has said it takes patches", async () => {
    const sent: string[] = [];
    const count = control(0);
    function App() {
      return createElement(View, null, createElement(Text, null, String(count.use())));
    }
    const transport = announcing(sent);
    const root = render(createElement(App), transport);
    await nextCommit();
    // Commits before the word are held.
    count.set(1);
    await nextCommit();
    expect(sent).toHaveLength(0);
    transport.emit({ type: "protocol", nodeId: "root", patches: 1 });
    expect(sent).toHaveLength(1);
    const tree = JSON.parse(sent[0] ?? "") as Node;
    const text = tree.children?.[0];
    expect(text).toMatchObject({ type: "text", children: ["1"] });
    expect(typeof text === "string" ? undefined : text?.props.id).toBeString();
    // Patches after it.
    count.set(2);
    await nextCommit();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toStartWith('{"patch":[');
    root.unmount();
  });

  test("a host that says nothing in time gets whole trees, as before", async () => {
    const sent: string[] = [];
    const count = control(0);
    function App() {
      return createElement(View, null, createElement(Text, null, String(count.use())));
    }
    const root = render(createElement(App), announcing(sent));
    await nextCommit();
    expect(sent).toHaveLength(0);
    await Bun.sleep(HOST_WORD_MS + 25);
    expect(sent).toHaveLength(1);
    expect((JSON.parse(sent[0] ?? "") as Node).children?.[0]).toEqual({
      type: "text",
      props: {},
      children: ["0"],
    });
    count.set(1);
    await nextCommit();
    expect(sent).toHaveLength(2);
    expect(root.lastTree()).toBe(sent.at(-1) ?? null);
    root.unmount();
  });
});

describe("hosts without patches", () => {
  test("get the whole tree, without ids on text, every commit", async () => {
    const sent: string[] = [];
    const count = control(0);
    function App() {
      return createElement(View, null, createElement(Text, null, String(count.use())));
    }
    const root = render(createElement(App), {
      send: (line) => sent.push(line),
      onEvent() {},
      onClose() {},
      simulate() {},
      close() {},
    });
    await nextCommit();
    count.set(1);
    await nextCommit();
    expect(sent).toHaveLength(2);
    const tree = JSON.parse(sent.at(-1) ?? "") as Node;
    expect(tree.children?.[0]).toEqual({ type: "text", props: {}, children: ["1"] });
    expect(root.lastTree()).toBe(sent.at(-1) ?? null);
    root.unmount();
  });

  test("a whole tree after changes is the tree an app mounted that way sends", async () => {
    interface Shape {
      rows: string[];
      wide: string;
      value: string;
    }
    const shape = control<Shape>({ rows: ["a", "b", "c"], wide: "b", value: "" });
    const seen: Shape[] = [];
    function App({ fixed }: { fixed?: Shape }) {
      const live = shape.use();
      const { rows, wide, value } = fixed ?? live;
      return createElement(
        View,
        { style: { padding: rows.length } },
        createElement(TextInput, { value, onChangeText() {} }),
        // Memoized: a row that didn't change keeps its props, and so its kept head.
        rows.map((key) => createElement(Row, { key, name: key, wide: key === wide })),
      );
    }
    const Row = memo(function Row({ name, wide }: { name: string; wide: boolean }) {
      return createElement(
        View,
        { style: { padding: 4, width: wide ? 200 : 100 }, onPress: wide ? () => {} : undefined },
        createElement(Text, null, name),
      );
    });
    const transport = (lines: string[]): NativeTransport => ({
      send: (line) => lines.push(line),
      onEvent() {},
      onClose() {},
      simulate() {},
      close() {},
    });
    const sent: string[] = [];
    const root = render(createElement(App), transport(sent));
    await nextCommit();
    for (const next of [
      { rows: ["a", "b", "c"], wide: "c", value: "" },
      { rows: ["a", "b", "c"], wide: "c", value: "typed" },
      { rows: ["c", "a", "d", "b"], wide: "a", value: "typed" },
      { rows: ["d"], wide: "d", value: "" },
      { rows: ["d"], wide: "d", value: "" },
    ]) {
      seen.push(next);
      shape.set(next);
      await nextCommit();
    }
    root.unmount();
    // The same shapes, each mounted from nothing: only the ids differ.
    const bare = (line: string) => line.replace(/"id":"\d+"/g, '"id":"?"');
    expect(sent).toHaveLength(seen.length + 1);
    for (const [index, fixed] of seen.entries()) {
      const lines: string[] = [];
      const fresh = render(createElement(App, { fixed }), transport(lines));
      await nextCommit();
      expect(bare(sent[index + 1] ?? "")).toBe(bare(lines[0] ?? ""));
      fresh.unmount();
    }
  });
});
