/**
 * What the Inks widgets asked of Metal (2026-11-17): the light weights and
 * the display cut, a row of dots in one node, a view's breathing, and a
 * second root said aloud instead of dropped.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createElement, Fragment, useState } from "react";
import { Dots, Text, View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { render } from "../src/render.ts";
import type { Material, NativeEvent, NativeTransport } from "../src/types.ts";

interface FakeTransport extends NativeTransport {
  sent: string[];
}

function fakeTransport(): FakeTransport {
  return {
    sent: [],
    send(treeJson) {
      this.sent.push(treeJson);
    },
    onEvent(_listener: (event: NativeEvent) => void) {},
    onClose() {},
    simulate() {},
    close() {},
  };
}

const nextCommit = () => Bun.sleep(25);

/** The last whole tree sent. */
function lastTree(transport: FakeTransport): {
  props: Record<string, unknown>;
  children: Array<{ type: string; props: Record<string, unknown>; children?: unknown[] }>;
} {
  return JSON.parse(transport.sent.at(-1) ?? "");
}

describe("the light weights and the display cut", () => {
  test("every weight is named as the host takes it, numbers or names", async () => {
    const weights = ["100", "200", "300", "400", "800", "900", "light", "black"] as const;
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        ...weights.map((fontWeight) =>
          createElement(Text, { key: fontWeight, style: { fontWeight } }, "42"),
        ),
        createElement(Text, { style: { fontFamily: "display", fontWeight: "200" } }, "9:41"),
      ),
      transport,
    );
    await nextCommit();
    const texts = lastTree(transport).children;
    expect(texts.map((text) => text.props.weight)).toEqual([
      "thin",
      "extralight",
      "light",
      // 400 is normal, which a node leaves out.
      undefined,
      "extrabold",
      "black",
      "light",
      "black",
      "extralight",
    ]);
    expect(texts.at(-1)?.props.display).toBe(true);
    expect(texts[0]?.props.display).toBeUndefined();
    root.unmount();
  });
});

describe("dots", () => {
  test("a row is one node, whatever its count", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        createElement(Dots, {
          count: 60.7,
          pitch: 6,
          radius: 2,
          lit: 23,
          head: 23,
          headRing: true,
          color: "#ffffff",
          unlitColor: "#ffffff40",
        }),
      ),
      transport,
    );
    await nextCommit();
    const children = lastTree(transport).children;
    expect(children).toHaveLength(1);
    expect(children[0]).toEqual({
      type: "dots",
      props: {
        count: 60,
        pitch: 6,
        radius: 2,
        lit: 23,
        color: "#ffffff",
        unlitColor: "#ffffff40",
        head: 23,
        headRing: true,
      },
    });
    root.unmount();
  });
});

describe("pulse", () => {
  test("a view says only the finite parts of its pulse", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        createElement(View, {
          style: { opacity: 0.8 },
          pulse: { from: 0.5, periodMs: 1600, fps: Number.NaN },
        }),
      ),
      transport,
    );
    await nextCommit();
    const tag = lastTree(transport).children[0];
    expect(tag?.props.opacity).toBe(0.8);
    expect(tag?.props.pulse).toEqual({ from: 0.5, periodMs: 1600 });
    root.unmount();
  });

  test("the host's word is parsed", () => {
    const line =
      '{"type":"protocol","nodeId":"root","patches":1,"fontWeights":true,"displayFont":true,"dots":true,"pulse":true}';
    expect(parseNativeEvent(line)).toEqual({
      type: "protocol",
      nodeId: "root",
      patches: 1,
      fontWeights: true,
      displayFont: true,
      dots: true,
      pulse: true,
    });
  });
});

describe("glass", () => {
  test("a view says its material, and nothing for one the host has no name for", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        createElement(View, {
          style: { backgroundColor: "#f8f8fa", borderRadius: 16 },
          material: "regular",
        }),
        // A name from another platform's materials, cast past the type as JS could send it.
        createElement(View, { material: "liquidGlass" as unknown as Material }),
      ),
      transport,
    );
    await nextCommit();
    const [panel, stray] = lastTree(transport).children;
    expect(panel?.props.material).toBe("regular");
    expect(panel?.props.background).toBe("#f8f8fa");
    expect(panel?.props.cornerRadius).toBe(16);
    expect(stray?.props.material).toBeUndefined();
    root.unmount();
  });

  test("the host's word is parsed", () => {
    const line = '{"type":"protocol","nodeId":"root","patches":1,"glass":true}';
    expect(parseNativeEvent(line)).toEqual({
      type: "protocol",
      nodeId: "root",
      patches: 1,
      glass: true,
    });
  });
});

describe("several roots", () => {
  const warn = spyOn(console, "warn");
  afterEach(() => warn.mockClear());

  test("a second root is said once, not dropped without a word", async () => {
    warn.mockImplementation(() => {});
    const transport = fakeTransport();
    let relabel: (label: string) => void = () => {};
    function TwoRoots() {
      const [label, setLabel] = useState("a");
      relabel = setLabel;
      return createElement(
        Fragment,
        null,
        createElement(View, { key: "login" }),
        createElement(View, { key: "glance" }, createElement(Text, null, label)),
      );
    }
    const root = render(createElement(TwoRoots), transport);
    await nextCommit();
    relabel("b");
    await nextCommit();
    const said = warn.mock.calls.map((call) => String(call[0]));
    expect(said.filter((line) => line.includes("2 root elements"))).toHaveLength(1);
    // The first is what is drawn.
    expect(lastTree(transport).children).toEqual([]);
    root.unmount();
    warn.mockRestore();
  });
});
