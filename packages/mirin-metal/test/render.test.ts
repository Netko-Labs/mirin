import { describe, expect, test } from "bun:test";
import { createContext, createElement, useContext, useState } from "react";
import { useWindowChrome } from "../src/chrome.ts";
import { Text, TextInput, TextInputDefaults, View } from "../src/components.ts";
import { parseNativeEvent } from "../src/host.ts";
import { textHash } from "../src/lib/text-hash.ts";
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

  test("a height transition is sent as heightTransitionMs", async () => {
    const transport = fakeTransport();
    const root = render(createElement(View, { style: { heightTransitionMs: 120 } }), transport);
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    expect(tree.props.heightTransitionMs).toBe(120);
    // A frame event is no one's handler's: dispatching it is harmless.
    transport.emit({ type: "frame", nodeId: "root" });
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
    expect(parseNativeEvent('{"type":"key","nodeId":"7","value":"Escape"}')).toEqual({
      type: "key",
      nodeId: "7",
      value: "Escape",
    });
    expect(parseNativeEvent('{"type":"key","nodeId":"7","value":"F5"}')).toBeNull();
    expect(parseNativeEvent('{"type":"selection","nodeId":"7","start":1,"end":3}')).toEqual({
      type: "selection",
      nodeId: "7",
      start: 1,
      end: 3,
    });
    expect(parseNativeEvent('{"type":"selection","nodeId":"7","start":3,"end":1}')).toBeNull();
    expect(
      parseNativeEvent('{"type":"selection","nodeId":"7","start":5,"end":5,"textHash":2565100923}'),
    ).toEqual({
      type: "selection",
      nodeId: "7",
      start: 5,
      end: 5,
      textHash: 2565100923,
    });
    // The host hashes as the driver does (events::text_hash).
    expect(textHash("1,250")).toBe(2565100923);
    expect(textHash("😀")).toBe(3409036472);
    expect(parseNativeEvent('{"type":"frame","nodeId":"root"}')).toEqual({
      type: "frame",
      nodeId: "root",
    });
    expect(parseNativeEvent('{"type":"frame","nodeId":"3"}')).toBeNull();
    expect(parseNativeEvent('{"type":"close-request","nodeId":"root"}')).toEqual({
      type: "close-request",
      nodeId: "root",
    });
    expect(parseNativeEvent('{"type":"close-request","nodeId":"3"}')).toBeNull();
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

  test("a press right after typing sees the typed text (discrete events render before the next)", async () => {
    const transport = fakeTransport();
    const saved: string[] = [];
    function Form() {
      const [token, setToken] = useState("");
      return createElement(
        View,
        null,
        createElement(TextInput, { value: token, testID: "token", onChangeText: setToken }),
        createElement(
          View,
          { testID: "save", onPress: () => saved.push(token) },
          createElement(Text, null, "Save"),
        ),
      );
    }
    const root = render(createElement(Form), transport);
    await nextCommit();
    const input = root.nodeId("token") ?? "";
    const save = root.nodeId("save") ?? "";
    // Back to back, with no time for a commit between them: what a fast typist's click does.
    transport.emit({ type: "change", nodeId: input, value: "sk-12" });
    transport.emit({ type: "change", nodeId: input, value: "sk-123" });
    transport.emit({ type: "press", nodeId: save });
    expect(saved).toEqual(["sk-123"]);
    root.unmount();
  });

  test("a controlled selection goes out and its changes come back", async () => {
    const transport = fakeTransport();
    const seen: Array<{ start: number; end: number }> = [];
    function Field() {
      const [selection, setSelection] = useState({ start: 0, end: 2.6 });
      return createElement(TextInput, {
        value: "hello",
        testID: "field",
        selection,
        selectionColor: "#3E8A7224",
        onSelectionChange: (next: { start: number; end: number }) => {
          seen.push(next);
          setSelection(next);
        },
      });
    }
    const root = render(createElement(Field), transport);
    await nextCommit();
    const id = root.nodeId("field") ?? "";
    const props = JSON.parse(transport.sent.at(-1) ?? "").props;
    expect(props).toMatchObject({
      selection: { start: 0, end: 2 },
      onSelection: true,
      selectionColor: "#3E8A7224",
    });

    transport.emit({ type: "selection", nodeId: id, start: 1, end: 4 });
    await nextCommit();
    expect(seen).toEqual([{ start: 1, end: 4 }]);
    expect(JSON.parse(transport.sent.at(-1) ?? "").props.selection).toEqual({ start: 1, end: 4 });
    root.unmount();
  });

  test("a selection made in a text the app replaced never reaches it", async () => {
    const transport = fakeTransport();
    const seen: Array<{ start: number; end: number }> = [];
    // A field that groups its digits as they are typed, with the caret after the same digit.
    function Grouped() {
      const [line, setLine] = useState({ text: "125", caret: 3 });
      return createElement(TextInput, {
        value: line.text,
        testID: "field",
        selection: { start: line.caret, end: line.caret },
        onChangeText: (raw: string) => {
          const digits = raw.replace(/,/g, "");
          const text = digits.length > 3 ? `${digits.slice(0, -3)},${digits.slice(-3)}` : digits;
          setLine({ text, caret: text.length });
        },
        onSelectionChange: (next: { start: number; end: number }) => {
          seen.push(next);
          setLine((old) => ({ ...old, caret: next.end }));
        },
      });
    }
    const root = render(createElement(Grouped), transport);
    await nextCommit();
    const id = root.nodeId("field") ?? "";
    const props = () => JSON.parse(transport.sent.at(-1) ?? "").props;
    // "0" typed: the field reports its text, then its caret in that text.
    transport.emit({ type: "change", nodeId: id, value: "1250" });
    expect(props()).toMatchObject({ value: "1,250", selection: { start: 5, end: 5 } });
    transport.emit({ type: "selection", nodeId: id, start: 4, end: 4, textHash: textHash("1250") });
    expect(seen).toEqual([]);
    expect(props().selection).toEqual({ start: 5, end: 5 });
    // The field took the app's text: what it reports now is in it, and gets through.
    transport.emit({
      type: "selection",
      nodeId: id,
      start: 2,
      end: 2,
      textHash: textHash("1,250"),
    });
    expect(seen).toEqual([{ start: 2, end: 2 }]);
    expect(props().selection).toEqual({ start: 2, end: 2 });
    // A host that doesn't say which text is believed, as before.
    transport.emit({ type: "selection", nodeId: id, start: 1, end: 1 });
    expect(seen.at(-1)).toEqual({ start: 1, end: 1 });
    root.unmount();
  });

  test("styled runs go out with the field, and a press on one comes back", async () => {
    const transport = fakeTransport();
    const pressed: Array<{ run: number; offset: number; shift: boolean }> = [];
    const root = render(
      createElement(TextInput, {
        value: "- [ ] **milk**",
        testID: "field",
        multiline: true,
        runs: [
          { start: 2, end: 5, color: "#3E8A72", press: true },
          {
            start: 6,
            end: 14.5,
            fontWeight: "bold",
            fontStyle: "italic",
            textDecorationLine: "line-through",
          },
          {
            start: 0,
            end: 14,
            fontSize: 20,
            backgroundColor: "#00000010",
            textDecorationLine: "underline",
          },
        ],
        onRunPress: (event: { run: number; offset: number; modifiers: { shift: boolean } }) =>
          pressed.push({ run: event.run, offset: event.offset, shift: event.modifiers.shift }),
      }),
      transport,
    );
    await nextCommit();
    const id = root.nodeId("field") ?? "";
    const props = JSON.parse(transport.sent.at(-1) ?? "").props;
    expect(props.runs).toEqual([
      { start: 2, end: 5, color: "#3E8A72", press: true },
      { start: 6, end: 14, weight: "bold", italic: true, strikethrough: true },
      { start: 0, end: 14, background: "#00000010", underline: true, size: 20 },
    ]);
    transport.emit({
      type: "runpress",
      nodeId: id,
      run: 0,
      offset: 3,
      modifiers: { shift: true, control: false, alt: false, super: false },
    });
    expect(pressed).toEqual([{ run: 0, offset: 3, shift: true }]);
    root.unmount();
  });

  test("a run press is parsed from the host", () => {
    expect(
      parseNativeEvent(
        '{"type":"runpress","nodeId":"7","run":1,"offset":4,"shift":false,"ctrl":true,"alt":false,"meta":false}',
      ),
    ).toEqual({
      type: "runpress",
      nodeId: "7",
      run: 1,
      offset: 4,
      modifiers: { shift: false, control: true, alt: false, super: false },
    });
    expect(parseNativeEvent('{"type":"runpress","nodeId":"7","run":-1,"offset":4}')).toBeNull();
    expect(parseNativeEvent('{"type":"runpress","nodeId":"7","run":1.5,"offset":4}')).toBeNull();
  });

  test("highlights and line numbers go out as the renderer takes them", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        createElement(TextInput, {
          value: "one two one",
          multiline: true,
          testID: "doc",
          highlights: [
            { start: 0, end: 3, color: "#E5B13F40" },
            { start: 8.4, end: 11, color: "#E5B13F99" },
          ],
          lineNumbers: { width: 36, color: "#1d1d1f66" },
        }),
        createElement(TextInput, { value: "plain", highlights: [] }),
      ),
      transport,
    );
    await nextCommit();
    const [doc, plain] = JSON.parse(transport.sent.at(-1) ?? "").children;
    expect(doc.props.highlights).toEqual([
      { start: 0, end: 3, color: "#E5B13F40" },
      { start: 8, end: 11, color: "#E5B13F99" },
    ]);
    expect(doc.props.lineNumbers).toEqual({ width: 36, color: "#1d1d1f66" });
    // None to draw: nothing sent, so a host without them still takes the field.
    expect(plain.props.highlights).toBeUndefined();
    expect(plain.props.lineNumbers).toBeUndefined();
    root.unmount();
  });

  test("a field that moves the keyboard on at Enter says so; others don't", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        createElement(TextInput, {
          value: "",
          testID: "title",
          focusNextOnSubmit: true,
          onSubmitEditing: () => {},
        }),
        createElement(TextInput, { value: "", testID: "body", multiline: true }),
      ),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    expect(tree.children[0].props).toMatchObject({ onSubmit: true, focusNextOnSubmit: true });
    expect(tree.children[1].props.focusNextOnSubmit).toBeUndefined();
    root.unmount();
  });

  test("TextInputDefaults gives fields a selection color they don't set", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        TextInputDefaults.Provider,
        { value: { selectionColor: "#00ff0033" } },
        createElement(
          View,
          null,
          createElement(TextInput, { value: "", testID: "plain" }),
          createElement(TextInput, { value: "", testID: "own", selectionColor: "#ff000033" }),
        ),
      ),
      transport,
    );
    await nextCommit();
    const [plain, own] = JSON.parse(transport.sent.at(-1) ?? "").children;
    expect(plain.props.selectionColor).toBe("#00ff0033");
    expect(own.props.selectionColor).toBe("#ff000033");
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

describe("flex", () => {
  test("flex grows from a zero basis; flexGrow grows from the content size", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        { style: { flex: 1 } },
        createElement(View, { style: { flex: 2 } }),
        createElement(View, { style: { flexGrow: 1 } }),
      ),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "{}") as {
      children: Array<{ props: Record<string, unknown> }>;
    };
    expect(tree.children[0]?.props.flex).toBe(2);
    expect(tree.children[0]?.props.grow).toBeUndefined();
    expect(tree.children[1]?.props.grow).toBe(1);
    expect(tree.children[1]?.props.flex).toBeUndefined();
    root.unmount();
  });
});

describe("raw strings in views", () => {
  test("a string a component returns renders as text in the view's textStyle", async () => {
    const transport = fakeTransport();
    const Label = () => "Status";
    const root = render(
      createElement(View, { textStyle: { color: "#ff0000", fontSize: 13 } }, createElement(Label)),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "{}") as {
      children: Array<{ type: string; props: Record<string, unknown>; children: string[] }>;
    };
    expect(tree.children[0]).toEqual({
      type: "text",
      props: { color: "#ff0000", size: 13 },
      children: ["Status"],
    });
    root.unmount();
  });
});

describe("window chrome", () => {
  test("parses chrome events, with and without controls", () => {
    expect(
      parseNativeEvent(
        '{"type":"chrome","nodeId":"root","titleBar":"unified","controls":{"x":0,"y":0,"width":80,"height":28}}',
      ),
    ).toEqual({
      type: "chrome",
      nodeId: "root",
      titleBar: "unified",
      controls: { x: 0, y: 0, width: 80, height: 28 },
    });
    expect(
      parseNativeEvent('{"type":"chrome","nodeId":"root","titleBar":"standard","controls":null}'),
    ).toEqual({ type: "chrome", nodeId: "root", titleBar: "standard", controls: null });
    // Junk: an unknown style, missing controls, controls that are not a rectangle.
    expect(
      parseNativeEvent('{"type":"chrome","nodeId":"root","titleBar":"x","controls":null}'),
    ).toBeNull();
    expect(parseNativeEvent('{"type":"chrome","nodeId":"root","titleBar":"unified"}')).toBeNull();
    expect(
      parseNativeEvent('{"type":"chrome","nodeId":"root","titleBar":"unified","controls":{"x":1}}'),
    ).toBeNull();
  });

  test("useWindowChrome starts standard and follows the chrome event", async () => {
    const transport = fakeTransport();
    const seen: Array<{ titleBar: string; controls: unknown }> = [];
    const Probe = () => {
      const chrome = useWindowChrome();
      seen.push(chrome);
      return createElement(Text, null, chrome.titleBar);
    };
    const root = render(createElement(Probe), transport);
    await nextCommit();
    expect(seen.at(-1)).toEqual({ titleBar: "standard", controls: null });

    const controls = { x: 0, y: 0, width: 80, height: 28 };
    transport.emit({ type: "chrome", nodeId: "root", titleBar: "unified", controls });
    await nextCommit();
    expect(seen.at(-1)).toEqual({ titleBar: "unified", controls });

    // The same report again does not render again.
    const renders = seen.length;
    transport.emit({
      type: "chrome",
      nodeId: "root",
      titleBar: "unified",
      controls: { ...controls },
    });
    await nextCommit();
    expect(seen.length).toBe(renders);

    transport.emit({ type: "chrome", nodeId: "root", titleBar: "standard", controls: null });
    await nextCommit();
    expect(seen.at(-1)).toEqual({ titleBar: "standard", controls: null });
    root.unmount();
  });

  test("dragRegion reaches the native tree only when set", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        null,
        createElement(View, { dragRegion: true }),
        createElement(View, { onPress: () => {} }),
      ),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "{}") as {
      children: Array<{ props: Record<string, unknown> }>;
    };
    expect(tree.children[0]?.props.dragRegion).toBe(true);
    expect(tree.children[1]?.props.dragRegion).toBeUndefined();
    root.unmount();
  });
});

describe("file drag and drop", () => {
  test("dragFiles goes out with the tree; drop events reach onDrop", async () => {
    const transport = fakeTransport();
    const heard: unknown[] = [];
    render(
      createElement(
        View,
        { onDrop: (event: unknown) => heard.push(event) },
        createElement(View, {
          dragFiles: { paths: ["/home/me/a.txt"], icon: "/icons/text.svg", iconSize: 40.4 },
        }),
      ),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "");
    expect(tree.props.onDrop).toBe(true);
    expect(tree.children[0].props.dragFiles).toEqual({
      paths: ["/home/me/a.txt"],
      icon: "/icons/text.svg",
      iconSize: 40,
    });
    transport.emit({
      type: "drop",
      nodeId: tree.props.id,
      phase: "drop",
      x: 5,
      y: 6,
      paths: ["/tmp/b"],
      ctrl: true,
      alt: false,
      shift: false,
    });
    expect(heard).toEqual([
      { phase: "drop", x: 5, y: 6, paths: ["/tmp/b"], ctrl: true, alt: false, shift: false },
    ]);
  });

  test("the host's drop line parses, and nothing malformed does", () => {
    expect(
      parseNativeEvent(
        '{"type":"drop","nodeId":"n1","phase":"enter","x":1,"y":2,"paths":["/a",3],"ctrl":false,"alt":true,"shift":false}',
      ),
    ).toEqual({
      type: "drop",
      nodeId: "n1",
      phase: "enter",
      x: 1,
      y: 2,
      paths: ["/a"],
      ctrl: false,
      alt: true,
      shift: false,
    });
    expect(
      parseNativeEvent('{"type":"drop","nodeId":"n1","phase":"fling","x":1,"y":2}'),
    ).toBeNull();
  });
});

describe("accessibility", () => {
  test("a view's and a field's accessibility props reach the tree as `access`, only when set", async () => {
    const transport = fakeTransport();
    const root = render(
      createElement(
        View,
        { accessibilityRole: "listbox", accessibilityLabel: "Results" },
        createElement(TextInput, {
          value: "wi",
          accessibilityRole: "combobox",
          accessibilityLabel: "Search",
          accessibilityState: { expanded: true },
        }),
        createElement(View, {
          accessibilityRole: "option",
          accessibilityLabel: "Wi-Fi, on, setting, 1 of 1",
          accessibilityState: { selected: true },
          accessibilityLiveRegion: "none",
        }),
        createElement(View, { accessibilityLiveRegion: "polite" }),
        createElement(View, {}),
      ),
      transport,
    );
    await nextCommit();
    const tree = JSON.parse(transport.sent.at(-1) ?? "null");
    expect(tree.props.access).toEqual({ role: "listbox", label: "Results" });
    const [field, option, notice, plain] = tree.children;
    expect(field.props.access).toEqual({ role: "combobox", label: "Search", expanded: true });
    expect(option.props.access).toEqual({
      role: "option",
      label: "Wi-Fi, on, setting, 1 of 1",
      selected: true,
    });
    expect(notice.props.access).toEqual({ live: "polite" });
    expect(plain.props.access).toBeUndefined();
    root.unmount();
  });
});
