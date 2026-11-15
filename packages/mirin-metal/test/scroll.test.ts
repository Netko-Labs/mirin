import { describe, expect, test } from "bun:test";
import { createElement, type RefObject, useState } from "react";
import { ScrollView, View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { markAnnounces } from "../src/lib/handshake.ts";
import { viewHeadJson } from "../src/lib/view-props.ts";
import { render } from "../src/render.ts";
import type { NativeEvent, NativeTransport, ScrollInfo, ViewHandle } from "../src/types.ts";

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
const SCROLLS: NativeEvent = { type: "protocol", nodeId: "root", patches: 1, scroll: true };
const OLD: NativeEvent = { type: "protocol", nodeId: "root", patches: 1 };

interface Handles {
  list: RefObject<ViewHandle | null>;
  row: RefObject<ViewHandle | null>;
  across: RefObject<ViewHandle | null>;
}

function handles(): Handles {
  return { list: { current: null }, row: { current: null }, across: { current: null } };
}

/** A list of rows whose last one is added by a press, and a strip that scrolls across. */
function listing(refs: Handles, heard: ScrollInfo[]) {
  return function Listing() {
    const [rows, setRows] = useState(3);
    return createElement(
      View,
      { testID: "page", onPress: () => setRows((count) => count + 1) },
      createElement(
        ScrollView,
        {
          ref: refs.list,
          testID: "list",
          onScroll: (event: ScrollInfo) => heard.push(event),
          scrollEventThrottle: 100,
        },
        Array.from({ length: rows }, (_, row) =>
          createElement(View, {
            key: row,
            testID: `row${row}`,
            ...(row === rows - 1 ? { ref: refs.row } : {}),
            style: { height: 40 },
          }),
        ),
      ),
      createElement(View, { ref: refs.across, style: { overflow: "scroll-x" } }),
    );
  };
}

async function mounted(protocol: NativeEvent | null) {
  const transport = fakeTransport();
  const refs = handles();
  const heard: ScrollInfo[] = [];
  const root = render(createElement(listing(refs, heard)), transport);
  await nextCommit();
  if (protocol) transport.emit(protocol);
  const id = (testID: string) => root.nodeId(testID) ?? "";
  return { transport, refs, heard, root, id };
}

describe("a scroll view's offset", () => {
  test("a host that reports it is told which views listen, and how often", async () => {
    const { root, id } = await mounted(SCROLLS);
    const tree = JSON.parse(root.lastTree() ?? "");
    expect(tree.children[0].props).toEqual({
      id: id("list"),
      scroll: true,
      onScroll: true,
      scrollThrottle: 100,
    });
    root.unmount();
  });

  test("its event reaches onScroll as React Native shapes it", async () => {
    const { transport, heard, root, id } = await mounted(SCROLLS);
    transport.emit({
      type: "scroll",
      nodeId: id("list"),
      x: 0,
      y: 120.5,
      contentWidth: 400,
      contentHeight: 800,
      width: 400,
      height: 200,
    });
    expect(heard).toEqual([
      {
        contentOffset: { x: 0, y: 120.5 },
        contentSize: { width: 400, height: 800 },
        layoutMeasurement: { width: 400, height: 200 },
      },
    ]);
    root.unmount();
  });

  test("a ref scrolls its view to an offset, to its end, and a child into view", async () => {
    const { transport, refs, root, id } = await mounted(SCROLLS);
    const lines = (): unknown[] => transport.sent.splice(0).map((line) => JSON.parse(line));
    lines();
    refs.list.current?.scrollTo({ y: 240 });
    refs.list.current?.scrollTo({ x: -5, y: Number.NaN });
    refs.list.current?.scrollTo({});
    refs.list.current?.scrollToEnd();
    refs.across.current?.scrollToEnd();
    refs.row.current?.scrollIntoView();
    expect(lines()).toEqual([
      { scrollTo: { id: id("list"), y: 240 } },
      { scrollTo: { id: id("list"), x: 0 } },
      { scrollTo: { id: id("list"), y: 1e9 } },
      {
        scrollTo: {
          id: refs.across.current ? (refs.across.current as unknown as { key: string }).key : "",
          x: 1e9,
        },
      },
      { scrollIntoView: { id: id("row2") } },
    ]);
    root.unmount();
  });

  test("a view that came with a commit is asked for after the patch that has it", async () => {
    const { transport, refs, root, id } = await mounted(SCROLLS);
    transport.sent.length = 0;
    transport.emit({ type: "press", nodeId: id("page") });
    refs.row.current?.scrollIntoView();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]).toContain('"op":"insert"');
    expect(JSON.parse(transport.sent[1] ?? "")).toEqual({ scrollIntoView: { id: id("row3") } });
    root.unmount();
  });

  test("a host from before it is told of no handler and asked for nothing", async () => {
    const { transport, refs, root } = await mounted(OLD);
    expect(root.lastTree()).not.toContain("onScroll");
    expect(root.lastTree()).not.toContain("scrollThrottle");
    transport.sent.length = 0;
    refs.list.current?.scrollTo({ y: 240 });
    refs.row.current?.scrollIntoView();
    expect(transport.sent).toEqual([]);
    root.unmount();
  });

  test("a transport that never says its protocol is treated as one from before it", async () => {
    const { transport, refs, root } = await mounted(null);
    expect(transport.sent.join("")).not.toContain("onScroll");
    refs.list.current?.scrollToEnd();
    expect(transport.sent.join("")).not.toContain("scrollTo");
    root.unmount();
  });

  test("a host that says so after a first tree gets one with the handlers", async () => {
    const { transport, root } = await mounted(null);
    expect(transport.sent.at(-1)).not.toContain("onScroll");
    transport.emit(SCROLLS);
    expect(transport.sent.at(-1)).toContain('"onScroll":true');
    root.unmount();
  });

  test("what is asked while the first tree waits for the host's word goes after it", async () => {
    const transport = markAnnounces(fakeTransport());
    const refs = handles();
    const root = render(createElement(listing(refs, [])), transport);
    await nextCommit();
    expect(transport.sent).toEqual([]);
    refs.list.current?.scrollTo({ y: 80 });
    transport.emit(SCROLLS);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]).toContain('"type":"view"');
    expect(JSON.parse(transport.sent[1] ?? "")).toEqual({
      scrollTo: { id: root.nodeId("list"), y: 80 },
    });
    root.unmount();
  });
});

describe("the wire", () => {
  test("onScroll and its throttle are written only for a host that takes them", () => {
    const props = {
      style: { overflow: "scroll" as const },
      onScroll: () => {},
      scrollEventThrottle: 50,
    };
    expect(viewHeadJson("7", props, false)).toBe(
      '{"type":"view","props":{"id":"7","scroll":true}}',
    );
    expect(viewHeadJson("7", props, false, true)).toBe(
      '{"type":"view","props":{"id":"7","scroll":true,"onScroll":true,"scrollThrottle":50}}',
    );
    // A throttle without a handler, or of nothing, is not sent.
    expect(viewHeadJson("7", { scrollEventThrottle: 50 }, false, true)).toBe(
      '{"type":"view","props":{"id":"7"}}',
    );
    expect(viewHeadJson("7", { onScroll: () => {}, scrollEventThrottle: 0 }, false, true)).toBe(
      '{"type":"view","props":{"id":"7","onScroll":true}}',
    );
  });

  test("a scroll event is parsed whole or not at all", () => {
    const line =
      '{"type":"scroll","nodeId":"4","x":0,"y":120.5,"contentWidth":400,"contentHeight":800,"width":400,"height":200}';
    expect(parseNativeEvent(line)).toEqual({
      type: "scroll",
      nodeId: "4",
      x: 0,
      y: 120.5,
      contentWidth: 400,
      contentHeight: 800,
      width: 400,
      height: 200,
    });
    expect(parseNativeEvent('{"type":"scroll","nodeId":"4","x":0,"y":1}')).toBeNull();
    expect(
      parseNativeEvent('{"type":"protocol","nodeId":"root","patches":1,"scroll":true}'),
    ).toEqual({ type: "protocol", nodeId: "root", patches: 1, scroll: true });
  });
});
