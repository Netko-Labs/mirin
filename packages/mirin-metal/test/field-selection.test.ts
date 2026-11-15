import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { TextInput, View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { FieldTexts } from "../src/lib/field-texts.ts";
import { textHash } from "../src/lib/text-hash.ts";
import { render } from "../src/render.ts";
import type { NativeEvent, NativeRoot, NativeTransport } from "../src/types.ts";

interface FakeTransport extends NativeTransport {
  sent: string[];
  emit(event: NativeEvent): void;
}

function fakeTransport(): FakeTransport {
  const listeners: Array<(event: NativeEvent) => void> = [];
  return {
    sent: [],
    send(treeJson) {
      this.sent.push(treeJson);
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    onClose() {},
    simulate() {},
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    close() {},
  };
}

const nextCommit = () => Bun.sleep(25);

/** A line the app also writes, which says its caret with every text: at its end. */
function Calculator() {
  const [line, setLine] = useState("");
  const [tint, setTint] = useState("#000000");
  return createElement(
    View,
    null,
    createElement(TextInput, {
      value: line,
      testID: "line",
      selection: { start: line.length, end: line.length },
      onChangeText: setLine,
      style: { color: tint },
    }),
    createElement(View, { testID: "seven", onPress: () => setLine((old) => `${old}7`) }),
    createElement(View, { testID: "tint", onPress: () => setTint("#ffffff") }),
  );
}

interface LineProps {
  value?: string;
  selection?: { start: number; end: number; textHash?: number };
}

/** The field's props as the host now has them. */
function line(root: NativeRoot): LineProps {
  const tree = JSON.parse(root.lastTree() ?? "") as { children: Array<{ props: LineProps }> };
  const field = tree.children[0];
  if (!field) throw new Error("no field");
  return field.props;
}

/** A change as a host that rebases reports it. */
function change(nodeId: string, value: string, typedOn: string): NativeEvent {
  return { type: "change", nodeId, value, baseHash: textHash(typedOn), textHash: textHash(value) };
}

async function mounted(protocol: NativeEvent) {
  const transport = fakeTransport();
  const root = render(createElement(Calculator), transport);
  await nextCommit();
  transport.emit(protocol);
  const node = (testID: string) => root.nodeId(testID) ?? "";
  return { transport, root, id: node("line"), seven: node("seven"), tint: node("tint") };
}

const NAMES_SELECTIONS: NativeEvent = {
  type: "protocol",
  nodeId: "root",
  patches: 1,
  rebase: true,
  selectionHash: true,
};

describe("a selection the app sets", () => {
  test("goes out with the text it was made in: the value written with it", async () => {
    const { transport, root, id, seven } = await mounted(NAMES_SELECTIONS);
    transport.emit({ type: "press", nodeId: seven });
    expect(line(root)).toMatchObject({
      value: "7",
      selection: { start: 1, end: 1, textHash: textHash("7") },
    });
    // "*6=" typed into the empty line before that tree arrived is not the app's.
    transport.emit(change(id, "*6=", "*6"));
    expect(line(root).selection).toEqual({ start: 1, end: 1, textHash: textHash("7") });
    // The field typed it again into the 7 and kept its caret; the app's follows what it hears.
    transport.emit(change(id, "7*6=", "7"));
    expect(line(root)).toMatchObject({
      value: "7*6=",
      selection: { start: 4, end: 4, textHash: textHash("7*6=") },
    });
    root.unmount();
  });

  test("keeps the text it was made in while it stays", async () => {
    const { transport, root, seven, tint } = await mounted(NAMES_SELECTIONS);
    transport.emit({ type: "press", nodeId: seven });
    // Another prop changes: the selection says the same.
    const before = line(root).selection;
    transport.emit({ type: "press", nodeId: tint });
    expect(line(root).selection).toEqual(before);
    root.unmount();
    // The field typed since, and the selection is still the one made in "7".
    const fields = new FieldTexts();
    fields.field("1", "7", undefined, true);
    expect(fields.selected("1", { start: 1, end: 1 })).toBe(textHash("7"));
    expect(fields.typed("1", "7!", textHash("7"), textHash("7!"))).toBe(true);
    expect(fields.selected("1", { start: 1, end: 1 })).toBe(textHash("7"));
    // A new one is made in what the field holds now.
    expect(fields.selected("1", { start: 2, end: 2 })).toBe(textHash("7!"));
    expect(fields.selected("1", undefined)).toBeUndefined();
  });

  test("names no text to a host that does not take one", async () => {
    const rebases: NativeEvent = { type: "protocol", nodeId: "root", patches: 1, rebase: true };
    const { transport, root, seven } = await mounted(rebases);
    transport.emit({ type: "press", nodeId: seven });
    expect(line(root)).toMatchObject({ value: "7", selection: { start: 1, end: 1 } });
    expect(transport.sent.join("")).not.toContain("textHash");
    root.unmount();
  });
});

describe("a caret the app mirrors", () => {
  test("is said once for a move the field reports, and not again when nothing comes back", async () => {
    // An app that follows the field: what it hears goes into `selection`.
    const seen: number[] = [];
    function Mirror() {
      const [caret, setCaret] = useState(4);
      return createElement(
        View,
        null,
        createElement(TextInput, {
          value: "abcd",
          testID: "line",
          selection: { start: caret, end: caret },
          onChangeText: () => {},
          onSelectionChange: ({ end }: { end: number }) => {
            seen.push(end);
            setCaret(end);
          },
        }),
        createElement(View, { testID: "home", onPress: () => setCaret(1) }),
      );
    }
    const transport = fakeTransport();
    const root = render(createElement(Mirror), transport);
    await nextCommit();
    transport.emit({ ...NAMES_SELECTIONS, noSelectionEcho: true } as NativeEvent);
    const [id, home] = [root.nodeId("line") ?? "", root.nodeId("home") ?? ""];
    const caret = () => line(root).selection?.end;
    const trees = () => transport.sent.length;
    // The app puts its caret at 1; the host takes it and says nothing.
    transport.emit({ type: "press", nodeId: home });
    expect(caret()).toBe(1);
    // The person's move, reported before the host took that tree: mirrored once.
    const before = trees();
    transport.emit({ type: "selection", nodeId: id, start: 3, end: 3, textHash: textHash("abcd") });
    expect(seen).toEqual([3]);
    expect(caret()).toBe(3);
    expect(trees()).toBe(before + 1);
    root.unmount();
  });
});

describe("parseNativeEvent", () => {
  test("a host that does not report the driver's own selection says so", () => {
    expect(
      parseNativeEvent(
        '{"type":"protocol","nodeId":"root","patches":1,"selectionHash":true,"noSelectionEcho":true}',
      ),
    ).toEqual({
      type: "protocol",
      nodeId: "root",
      patches: 1,
      selectionHash: true,
      noSelectionEcho: true,
    });
  });

  test("a host that takes a selection's text says so", () => {
    expect(
      parseNativeEvent(
        '{"type":"protocol","nodeId":"root","patches":1,"rebase":true,"selectionHash":true}',
      ),
    ).toEqual({ type: "protocol", nodeId: "root", patches: 1, rebase: true, selectionHash: true });
  });
});
