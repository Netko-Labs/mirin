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

/** A line the app writes too: its keypad's 7 appends to what it holds. */
function calculator(initial: string, heard: string[]) {
  return function Calculator() {
    const [line, setLine] = useState(initial);
    return createElement(
      View,
      null,
      createElement(TextInput, {
        value: line,
        testID: "line",
        onChangeText: (text: string) => {
          heard.push(text);
          setLine(text);
        },
      }),
      createElement(View, { testID: "seven", onPress: () => setLine((old) => `${old}7`) }),
    );
  };
}

/** The field's props as the host now has them. */
function line(root: NativeRoot): { value?: string; baseHash?: number; [prop: string]: unknown } {
  const tree = JSON.parse(root.lastTree() ?? "") as {
    children: Array<{ props: { value?: string; baseHash?: number } }>;
  };
  const field = tree.children[0];
  if (!field) throw new Error("no field");
  return field.props;
}

/** A change as a host that rebases reports it. */
function change(nodeId: string, value: string, typedOn: string): NativeEvent {
  return { type: "change", nodeId, value, baseHash: textHash(typedOn), textHash: textHash(value) };
}

async function mounted(initial: string, protocol: NativeEvent | null) {
  const transport = fakeTransport();
  const heard: string[] = [];
  const root = render(createElement(calculator(initial, heard)), transport);
  await nextCommit();
  if (protocol) transport.emit(protocol);
  const id = root.nodeId("line") ?? "";
  const seven = root.nodeId("seven") ?? "";
  return { transport, heard, root, id, seven };
}

const REBASES: NativeEvent = { type: "protocol", nodeId: "root", patches: 1, rebase: true };

describe("a field the app also writes", () => {
  test("keys typed before the field took the app's write reach the app once, after it", async () => {
    const { transport, heard, root, id, seven } = await mounted("", REBASES);
    expect(line(root)).toEqual(expect.not.objectContaining({ baseHash: expect.anything() }));
    // The keypad's 7: the app writes over the empty text it knows.
    transport.emit({ type: "press", nodeId: seven });
    expect(line(root)).toMatchObject({ value: "7", baseHash: textHash("") });
    // "*6=" was typed into the empty line before that tree arrived.
    transport.emit(change(id, "*", ""));
    transport.emit(change(id, "*6", "*"));
    transport.emit(change(id, "*6=", "*6"));
    expect(heard).toEqual([]);
    expect(line(root).value).toBe("7");
    // The field took the 7 and typed them again into it.
    transport.emit(change(id, "7*6=", "7"));
    expect(heard).toEqual(["7*6="]);
    // The app shows it: the field's own text, named as such.
    expect(line(root)).toMatchObject({ value: "7*6=", baseHash: textHash("7*6=") });
    root.unmount();
  });

  test("a key heard before the app writes is in what the app writes over", async () => {
    const { transport, heard, root, id, seven } = await mounted("5", REBASES);
    transport.emit(change(id, "5*", "5"));
    expect(heard).toEqual(["5*"]);
    transport.emit({ type: "press", nodeId: seven });
    expect(line(root)).toMatchObject({ value: "5*7", baseHash: textHash("5*") });
    // Typed on the app's own text: it gets through.
    transport.emit(change(id, "5*76", "5*7"));
    expect(heard).toEqual(["5*", "5*76"]);
    root.unmount();
  });

  test("a second write goes out over the first, and only a change made on it is heard", async () => {
    const { transport, heard, root, id, seven } = await mounted("", REBASES);
    transport.emit({ type: "press", nodeId: seven });
    transport.emit({ type: "press", nodeId: seven });
    expect(line(root)).toMatchObject({ value: "77", baseHash: textHash("7") });
    // The field took the first write and typed on it; the second is on its way.
    transport.emit(change(id, "7x", "7"));
    expect(heard).toEqual([]);
    transport.emit(change(id, "77x", "77"));
    expect(heard).toEqual(["77x"]);
    root.unmount();
  });

  test("a host from before it is sent no baseHash and is believed, as before", async () => {
    const old: NativeEvent = { type: "protocol", nodeId: "root", patches: 1 };
    const { transport, heard, root, id, seven } = await mounted("", old);
    transport.emit({ type: "press", nodeId: seven });
    expect(line(root)).toEqual({ id, value: "7", onChange: true });
    transport.emit({ type: "change", nodeId: id, value: "*" });
    expect(heard).toEqual(["*"]);
    expect(transport.sent.join("")).not.toContain("baseHash");
    root.unmount();
  });

  test("a transport that never says its protocol is sent no baseHash", async () => {
    const { transport, root, seven } = await mounted("", null);
    transport.emit({ type: "press", nodeId: seven });
    expect(transport.sent.at(-1)).toContain('"value":"7"');
    expect(transport.sent.join("")).not.toContain("baseHash");
    root.unmount();
  });
});

describe("a key the app refuses", () => {
  /** A line that takes no "x": it writes its text again (a new revision). */
  function Refusing({ heard }: { heard: string[] }) {
    const [line, setLine] = useState({ text: "", revision: 0 });
    return createElement(
      View,
      null,
      createElement(TextInput, {
        value: line.text,
        valueRevision: line.revision,
        testID: "line",
        onChangeText: (text: string) => {
          heard.push(text);
          const kept = text.replaceAll("x", "");
          setLine((old) => ({ text: kept, revision: old.revision + (kept === text ? 0 : 1) }));
        },
      }),
    );
  }

  test("is taken out by a write over the text that had it, and the keys after it are heard once", async () => {
    const transport = fakeTransport();
    const heard: string[] = [];
    const root = render(createElement(Refusing, { heard }), transport);
    await nextCommit();
    transport.emit(REBASES);
    const id = root.nodeId("line") ?? "";
    // "12x+3" typed at once: the field reports each key before the app answers any.
    transport.emit(change(id, "1", ""));
    transport.emit(change(id, "12", "1"));
    expect(line(root)).toMatchObject({ value: "12", baseHash: textHash("12") });
    transport.emit(change(id, "12x", "12"));
    // The same text again, written over the one with the x.
    expect(line(root)).toMatchObject({ value: "12", revision: 1, baseHash: textHash("12x") });
    // What was typed on the text with the x is not the app's.
    transport.emit(change(id, "12x+", "12x"));
    transport.emit(change(id, "12x+3", "12x+"));
    expect(heard).toEqual(["1", "12", "12x"]);
    // The field took the write and typed "+3" again on it.
    transport.emit(change(id, "12+3", "12"));
    expect(heard).toEqual(["1", "12", "12x", "12+3"]);
    expect(line(root)).toMatchObject({ value: "12+3", revision: 1, baseHash: textHash("12+3") });
    root.unmount();
  });

  test("goes out with no text to a host from before it", async () => {
    const transport = fakeTransport();
    const root = render(createElement(Refusing, { heard: [] }), transport);
    await nextCommit();
    transport.emit({ type: "protocol", nodeId: "root", patches: 1 });
    const id = root.nodeId("line") ?? "";
    transport.emit({ type: "change", nodeId: id, value: "x" });
    expect(line(root)).toMatchObject({ value: "", revision: 1 });
    expect(transport.sent.join("")).not.toContain("baseHash");
    root.unmount();
  });
});

describe("FieldTexts", () => {
  test("a value keeps the hash it went out with for as long as it stays", () => {
    const fields = new FieldTexts();
    expect(fields.field("1", "", undefined, true)).toBeUndefined();
    expect(fields.field("1", "7", undefined, true)).toBe(textHash(""));
    // Typed since: the same value again (another prop changed) says the same.
    expect(fields.typed("1", "7*", textHash("7"), textHash("7*"))).toBe(true);
    expect(fields.field("1", "7", undefined, true)).toBe(textHash(""));
    // A new revision is the app's value written again, over what the field typed.
    expect(fields.field("1", "7", 1, true)).toBe(textHash("7*"));
    expect(fields.typed("1", "7*", textHash("7*"))).toBe(false);
    expect(fields.typed("1", "7!", textHash("7"))).toBe(true);
    // To a host that takes no text it says none.
    expect(fields.field("1", "7", 2, false)).toBeUndefined();
  });

  test("a field it does not know, or a host that names no text, is believed", () => {
    const fields = new FieldTexts();
    expect(fields.typed("9", "a", 1, 2)).toBe(true);
    fields.field("1", "abc", undefined, false);
    expect(fields.typed("1", "x")).toBe(true);
    expect(fields.holds("1", textHash("x"))).toBe(true);
  });
});

describe("parseNativeEvent", () => {
  test("a change says the text it was typed on and its own", () => {
    expect(
      parseNativeEvent('{"type":"change","nodeId":"4","value":"7*","baseHash":1,"textHash":2}'),
    ).toEqual({ type: "change", nodeId: "4", value: "7*", baseHash: 1, textHash: 2 });
    expect(parseNativeEvent('{"type":"change","nodeId":"4","value":"7*"}')).toEqual({
      type: "change",
      nodeId: "4",
      value: "7*",
    });
  });

  test("a host that rebases says so", () => {
    expect(
      parseNativeEvent(
        '{"type":"protocol","nodeId":"root","patches":1,"settle":true,"rebase":true}',
      ),
    ).toEqual({ type: "protocol", nodeId: "root", patches: 1, settle: true, rebase: true });
    expect(
      parseNativeEvent(
        '{"type":"protocol","nodeId":"root","patches":1,"rebase":true,"revisionRebase":true}',
      ),
    ).toEqual({ type: "protocol", nodeId: "root", patches: 1, rebase: true, revisionRebase: true });
  });
});
