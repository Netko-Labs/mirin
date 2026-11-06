import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { render } from "../src/render.ts";
import type {
  Modifiers,
  NativeEvent,
  NativeTransport,
  PressInfo,
  WindowKeyInfo,
} from "../src/types.ts";

function fakeTransport(): NativeTransport & { sent: string[]; emit(event: NativeEvent): void } {
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

interface Node {
  type: string;
  props: Record<string, unknown>;
  children?: Node[];
}

const NONE: Modifiers = { shift: false, control: false, alt: false, super: false };

describe("focus props", () => {
  test("serialize onto the view, with the window's keys routed back", async () => {
    const transport = fakeTransport();
    const keys: WindowKeyInfo[] = [];
    render(
      createElement(
        View,
        {
          style: { focusRingColor: "#336699" },
          focusTrap: true,
          onWindowKeyDown: (key: WindowKeyInfo) => keys.push(key),
        },
        createElement(
          View,
          { focusGroup: true, selectsOnFocus: true },
          createElement(View, { focusable: true, onPress: () => {} }),
        ),
        // selectsOnFocus means nothing outside a group.
        createElement(View, { selectsOnFocus: true }),
      ),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "{}") as Node;
    expect(tree.props).toMatchObject({
      focusTrap: true,
      focusRingColor: "#336699",
      onWindowKey: true,
    });
    const [group, loose] = tree.children ?? [];
    expect(group?.props).toMatchObject({ focusGroup: true, selectsOnFocus: true });
    expect(group?.children?.[0]?.props).toMatchObject({ focusable: true, onPress: true });
    expect(loose?.props.selectsOnFocus).toBeUndefined();
    transport.emit({
      type: "windowkey",
      nodeId: String(tree.props.id),
      key: "v",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
      repeat: false,
      pasted: "42",
    });
    expect(keys).toEqual([
      { key: "v", ctrl: true, alt: false, shift: false, meta: false, repeat: false, pasted: "42" },
    ]);
  });

  test("a press carries the modifiers held, and none from an older host", async () => {
    const transport = fakeTransport();
    const presses: PressInfo[] = [];
    render(createElement(View, { onPress: (event: PressInfo) => presses.push(event) }), transport);
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "{}") as Node;
    const nodeId = String(tree.props.id);
    const shifted: Modifiers = { ...NONE, shift: true };
    transport.emit({ type: "press", nodeId, modifiers: shifted });
    transport.emit({ type: "press", nodeId });
    expect(presses.map((press) => press.modifiers)).toEqual([shifted, NONE]);
  });
});

describe("parseNativeEvent", () => {
  test("reads modifiers, window keys, and visibility", () => {
    expect(
      parseNativeEvent(
        '{"type":"press","nodeId":"3","shift":true,"ctrl":false,"alt":false,"meta":true}',
      ),
    ).toEqual({
      type: "press",
      nodeId: "3",
      modifiers: { shift: true, control: false, alt: false, super: true },
    });
    expect(parseNativeEvent('{"type":"contextmenu","nodeId":"5","x":1,"y":2,"ctrl":true}')).toEqual(
      {
        type: "contextmenu",
        nodeId: "5",
        x: 1,
        y: 2,
        modifiers: { shift: false, control: true, alt: false, super: false },
      },
    );
    expect(parseNativeEvent('{"type":"windowkey","nodeId":"9","key":"a","text":"a"}')).toEqual({
      type: "windowkey",
      nodeId: "9",
      key: "a",
      text: "a",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      repeat: false,
    });
    expect(parseNativeEvent('{"type":"windowkey","nodeId":"9"}')).toBeNull();
    expect(parseNativeEvent('{"type":"visibility","nodeId":"root","visible":false}')).toEqual({
      type: "visibility",
      nodeId: "root",
      visible: false,
    });
    expect(parseNativeEvent('{"type":"visibility","nodeId":"3","visible":true}')).toBeNull();
    expect(parseNativeEvent('{"type":"visibility","nodeId":"root"}')).toBeNull();
  });

  test("reads whether a field is typing", () => {
    expect(parseNativeEvent('{"type":"typing","nodeId":"root","typing":true}')).toEqual({
      type: "typing",
      nodeId: "root",
      typing: true,
    });
    expect(parseNativeEvent('{"type":"typing","nodeId":"root","typing":false}')).toEqual({
      type: "typing",
      nodeId: "root",
      typing: false,
    });
    expect(parseNativeEvent('{"type":"typing","nodeId":"4","typing":true}')).toBeNull();
    expect(parseNativeEvent('{"type":"typing","nodeId":"root"}')).toBeNull();
  });
});
