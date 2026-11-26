/**
 * The window's glass as a tree hears it (`useWindowGlass`, src/glass.ts):
 * the host's word that it takes `material`, the compositor's `drawing` and
 * `tone`; and a focus ring's gap (`focusRingGapColor`).
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  NO_GLASS,
  useHostProtocol,
  useWindowActive,
  useWindowGlass,
  type WindowGlass,
} from "../src/chrome.ts";
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
    onClose() {},
    simulate() {},
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    close() {},
  };
}

const nextCommit = () => Bun.sleep(25);

describe("the window's glass", () => {
  test("a glass line is parsed, and junk is not", () => {
    expect(
      parseNativeEvent('{"type":"glass","nodeId":"root","drawing":true,"tone":"#7a8c9e"}'),
    ).toEqual({
      type: "glass",
      nodeId: "root",
      drawing: true,
      tone: "#7a8c9e",
    });
    expect(
      parseNativeEvent('{"type":"glass","nodeId":"root","drawing":false,"tone":null}'),
    ).toEqual({
      type: "glass",
      nodeId: "root",
      drawing: false,
      tone: null,
    });
    // A tone that is not a colour is no tone; no drawing is no event.
    expect(
      parseNativeEvent('{"type":"glass","nodeId":"root","drawing":true,"tone":"blue"}'),
    ).toEqual({
      type: "glass",
      nodeId: "root",
      drawing: true,
      tone: null,
    });
    expect(parseNativeEvent('{"type":"glass","nodeId":"root","tone":"#000000"}')).toBeNull();
    expect(
      parseNativeEvent(
        '{"type":"protocol","nodeId":"root","patches":1,"glass":true,"focusGap":true}',
      ),
    ).toEqual({
      type: "protocol",
      nodeId: "root",
      patches: 1,
      glass: true,
      focusGap: true,
    });
  });

  test("useWindowGlass starts with none, then follows the host's protocol line and its reports", async () => {
    const transport = fakeTransport();
    const seen: WindowGlass[] = [];
    const Probe = () => {
      const glass = useWindowGlass();
      seen.push(glass);
      return createElement(Text, null, glass.tone ?? "none");
    };
    const root = render(createElement(Probe), transport);
    await nextCommit();
    expect(seen.at(-1)).toEqual(NO_GLASS);

    transport.emit({ type: "protocol", nodeId: "root", patches: 1, glass: true });
    await nextCommit();
    expect(seen.at(-1)).toEqual({ available: true, drawing: false, tone: null });

    transport.emit({ type: "glass", nodeId: "root", drawing: true, tone: "#334455" });
    await nextCommit();
    expect(seen.at(-1)).toEqual({ available: true, drawing: true, tone: "#334455" });

    // The same report again renders nothing again.
    const renders = seen.length;
    transport.emit({ type: "glass", nodeId: "root", drawing: true, tone: "#334455" });
    await nextCommit();
    expect(seen.length).toBe(renders);
    root.unmount();
  });

  test("a ring's gap is sent with the view, as its ring's color is", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(View, { style: { focusRingColor: "#6e56cf", focusRingGapColor: "#ffffff" } }),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "{}");
    const props = tree.props ?? tree.children?.[0]?.props;
    expect(props.focusRingColor).toBe("#6e56cf");
    expect(props.focusRingGapColor).toBe("#ffffff");
    root.unmount();
  });
});

describe("the window's activity", () => {
  test("useWindowActive is true until the host says otherwise, and follows it", async () => {
    expect(parseNativeEvent('{"type":"active","nodeId":"root","active":false}')).toEqual({
      type: "active",
      nodeId: "root",
      active: false,
    });
    expect(parseNativeEvent('{"type":"active","nodeId":"root"}')).toBeNull();
    const transport = fakeTransport();
    const seen: boolean[] = [];
    const Probe = () => {
      const active = useWindowActive();
      seen.push(active);
      return createElement(Text, null, active ? "on" : "off");
    };
    const root = render(createElement(Probe), transport);
    await nextCommit();
    expect(seen.at(-1)).toBe(true);
    transport.emit({ type: "active", nodeId: "root", active: false });
    await nextCommit();
    expect(seen.at(-1)).toBe(false);
    transport.emit({ type: "active", nodeId: "root", active: true });
    await nextCommit();
    expect(seen.at(-1)).toBe(true);
    root.unmount();
  });
});

describe("the host's word", () => {
  test("useHostProtocol is null until the host says, then its protocol line", async () => {
    const transport = fakeTransport();
    const seen: Array<boolean | null> = [];
    const Probe = () => {
      const said = useHostProtocol();
      seen.push(said === null ? null : said.focusGap === true);
      return createElement(Text, null, "x");
    };
    const root = render(createElement(Probe), transport);
    await nextCommit();
    expect(seen.at(-1)).toBeNull();
    transport.emit({ type: "protocol", nodeId: "root", patches: 1, glass: true, focusGap: true });
    await nextCommit();
    expect(seen.at(-1)).toBe(true);
    root.unmount();
  });
});
