import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { Image, View } from "../src/components.ts";
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
const TELLS: NativeEvent = { type: "protocol", nodeId: "root", patches: 1, imageError: true };

/** A picture that falls back to another file when the host cannot draw it, beside one that does not listen. */
function Avatar({ heard }: { heard: string[] }) {
  const [source, setSource] = useState("/pictures/me.avif");
  return createElement(
    View,
    null,
    createElement(Image, {
      source,
      onError: (event: { error: string }) => {
        heard.push(event.error);
        setSource("/icons/person.png");
      },
    }),
    createElement(Image, { source: "/pictures/quiet.avif" }),
  );
}

interface ImageNode {
  type: string;
  props: { id?: string; src: string; onError?: boolean };
}

function images(json: string | null | undefined): ImageNode[] {
  return (JSON.parse(json ?? "") as { children: ImageNode[] }).children;
}

describe("an image the host cannot draw", () => {
  test("its handler is said to a host that tells, and the event reaches it", async () => {
    const transport = fakeTransport();
    const heard: string[] = [];
    const root = render(createElement(Avatar, { heard }), transport);
    await nextCommit();
    transport.emit(TELLS);
    const [listening, quiet] = images(root.lastTree());
    expect(listening?.props).toMatchObject({ src: "/pictures/me.avif", onError: true });
    expect(quiet?.props.onError).toBeUndefined();
    transport.emit({
      type: "imageerror",
      nodeId: listening?.props.id ?? "",
      error: "not an image the host can decode",
    });
    await nextCommit();
    expect(heard).toEqual(["not an image the host can decode"]);
    // The app's stand-in went out in its place.
    expect(images(root.lastTree())[0]?.props.src).toBe("/icons/person.png");
    // An event for a node that is not an image with a handler is nobody's.
    transport.emit({ type: "imageerror", nodeId: quiet?.props.id ?? "", error: "no such file" });
    expect(heard).toHaveLength(1);
    root.unmount();
  });

  test("a host that takes whole trees still gets an id on an image that listens", async () => {
    const transport = fakeTransport();
    const root = render(createElement(Avatar, { heard: [] }), transport);
    await nextCommit();
    // It says it tells of errors, in a protocol this driver does not patch in.
    transport.emit({ type: "protocol", nodeId: "root", patches: 99, imageError: true });
    const [listening, quiet] = images(transport.sent.at(-1));
    expect(listening?.props.onError).toBe(true);
    expect(listening?.props.id).toMatch(/^\d+$/);
    expect(quiet?.props.id).toBeUndefined();
    root.unmount();
  });

  test("a host from before it is told of no handler", async () => {
    const transport = fakeTransport();
    const root = render(createElement(Avatar, { heard: [] }), transport);
    await nextCommit();
    expect(transport.sent.join("")).not.toContain("onError");
    transport.emit({ type: "protocol", nodeId: "root", patches: 1 });
    expect(transport.sent.join("")).not.toContain("onError");
    root.unmount();
  });

  test("its event is parsed, and the host's word", () => {
    expect(parseNativeEvent('{"type":"imageerror","nodeId":"9","value":"no such file"}')).toEqual({
      type: "imageerror",
      nodeId: "9",
      error: "no such file",
    });
    expect(parseNativeEvent('{"type":"imageerror","nodeId":"9"}')).toBeNull();
    expect(
      parseNativeEvent('{"type":"protocol","nodeId":"root","patches":1,"imageError":true}'),
    ).toEqual({ type: "protocol", nodeId: "root", patches: 1, imageError: true });
  });
});
