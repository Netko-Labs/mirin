import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { Text, View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { render } from "../src/render.ts";
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
    expect(tree.props).toEqual({ fill: true, center: true, gap: 12 });
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
  test("accepts press events and rejects junk", () => {
    expect(parseNativeEvent('{"type":"press","nodeId":"3"}')).toEqual({
      type: "press",
      nodeId: "3",
    });
    expect(parseNativeEvent('{"type":"press"}')).toBeNull();
    expect(parseNativeEvent("not json")).toBeNull();
    expect(parseNativeEvent('"press"')).toBeNull();
  });
});
