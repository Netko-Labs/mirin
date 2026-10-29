import { describe, expect, test } from "bun:test";
import { createContext, createElement, useContext, useState } from "react";
import { Text, TextInput, View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { createPortal, render } from "../src/render.ts";
import type { NativeEvent, NativeTransport } from "../src/types.ts";

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
      for (const listener of listeners) {
        listener(event);
      }
    },
    close() {},
  };
}

const nextCommit = () => Bun.sleep(25);

function Counter() {
  const [count, setCount] = useState(0);
  return createElement(
    View,
    { style: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 } },
    createElement(Text, { style: { fontSize: 28, color: "#f4f4f5" } }, `count: ${count}`),
    createElement(
      View,
      {
        style: { padding: 12, borderRadius: 8, backgroundColor: "#3b82f6" },
        onPress: () => setCount((current) => current + 1),
      },
      createElement(Text, { style: { color: "#ffffff" } }, "tap me"),
    ),
  );
}

describe("render", () => {
  test("commits normal React as the native element tree", async () => {
    const transport = fakeTransport();
    const root = render(createElement(Counter), transport);
    await nextCommit();

    expect(transport.sent.length).toBeGreaterThan(0);
    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    expect(tree.type).toBe("view");
    expect(tree.props).toEqual({
      id: expect.any(String),
      flex: 1,
      center: true,
      gap: 12,
      fill: true,
    });
    expect(tree.children[0]).toEqual({
      type: "text",
      props: { color: "#f4f4f5", size: 28 },
      children: ["count: 0"],
    });
    const button = tree.children[1];
    expect(button.props.onPress).toBe(true);
    expect(button.props.cornerRadius).toBe(8);
    expect(typeof button.props.id).toBe("string");
    root.unmount();
  });

  test("press events re-render and send an updated tree", async () => {
    const transport = fakeTransport();
    const root = render(createElement(Counter), transport);
    await nextCommit();

    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    transport.emit({ type: "press", nodeId: tree.children[1].props.id });
    await nextCommit();

    const updated = JSON.parse(transport.sent.at(-1) ?? "");
    expect(updated.children[0].children).toEqual(["count: 1"]);
    root.unmount();
  });
});

describe("parseNativeEvent", () => {
  test("accepts press/change/submit events and rejects junk", () => {
    expect(parseNativeEvent('{"type":"press","nodeId":"3"}')).toEqual({
      type: "press",
      nodeId: "3",
    });
    expect(
      parseNativeEvent('{"type":"press","nodeId":"3","bounds":{"x":1,"y":2,"width":3,"height":4}}'),
    ).toEqual({ type: "press", nodeId: "3", bounds: { x: 1, y: 2, width: 3, height: 4 } });
    expect(
      parseNativeEvent('{"type":"pointer","nodeId":"5","phase":"move","x":10,"y":20}'),
    ).toEqual({ type: "pointer", nodeId: "5", phase: "move", x: 10, y: 20 });
    expect(parseNativeEvent('{"type":"contextmenu","nodeId":"5","x":1,"y":2}')).toEqual({
      type: "contextmenu",
      nodeId: "5",
      x: 1,
      y: 2,
    });
    expect(parseNativeEvent('{"type":"change","nodeId":"7","value":"sel"}')).toEqual({
      type: "change",
      nodeId: "7",
      value: "sel",
    });
    expect(parseNativeEvent('{"type":"submit","nodeId":"7"}')).toBeNull();
    expect(parseNativeEvent('{"type":"press"}')).toBeNull();
    expect(parseNativeEvent("not json")).toBeNull();
    expect(parseNativeEvent('"press"')).toBeNull();
  });
});

describe("TextInput", () => {
  test("serializes as a controlled input and routes change/submit back", async () => {
    const transport = fakeTransport();
    const seen: string[] = [];
    function Editor() {
      const [sql, setSql] = useState("select 1");
      return createElement(
        View,
        null,
        createElement(TextInput, {
          value: sql,
          multiline: true,
          autoFocus: true,
          testID: "sql",
          style: { fontFamily: "monospace", borderColor: "#333" },
          onChangeText: setSql,
          onSubmitEditing: (text: string) => seen.push(text),
        }),
        createElement(Text, null, sql),
      );
    }
    const root = render(createElement(Editor), transport);
    await nextCommit();

    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    expect(root.lastTree()).toBe(transport.sent.at(-1) ?? null);
    const input = tree.children[0];
    expect(root.nodeId("sql")).toBe(input.props.id);
    expect(root.nodeId("missing")).toBeUndefined();
    expect(input.type).toBe("input");
    expect(input.props).toEqual({
      id: expect.any(String),
      value: "select 1",
      multiline: true,
      autofocus: true,
      mono: true,
      borderColor: "#333",
      onChange: true,
      onSubmit: true,
    });

    transport.emit({ type: "change", nodeId: input.props.id, value: "select 2" });
    await nextCommit();
    const updated = JSON.parse(transport.sent.at(-1) ?? "");
    expect(updated.children[0].props.value).toBe("select 2");
    expect(updated.children[1].children).toEqual(["select 2"]);

    transport.emit({ type: "submit", nodeId: input.props.id, value: "select 2" });
    expect(seen).toEqual(["select 2"]);
    root.unmount();
  });
});

describe("createPortal", () => {
  test("renders into another mounted view and keeps context", async () => {
    const transport = fakeTransport();
    const Label = createContext("missing");
    function Reader() {
      return createElement(Text, null, useContext(Label));
    }
    function App() {
      const [layer, setLayer] = useState<unknown>(null);
      return createElement(
        Label.Provider,
        { value: "from context" },
        createElement(
          View,
          null,
          createElement(
            View,
            { testID: "content" },
            layer ? createPortal(createElement(Reader), layer) : null,
          ),
          createElement(View, { ref: setLayer, testID: "layer" } as never),
        ),
      );
    }
    const root = render(createElement(App), transport);
    await nextCommit();
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    const [content, layer] = tree.children;
    expect(content.children).toEqual([]);
    expect(layer.children[0]).toEqual({ type: "text", props: {}, children: ["from context"] });
    root.unmount();
  });
});
