import { describe, expect, test } from "bun:test";
import { formatAxTree } from "../src/devtools/lib/ax.ts";

/** Shorthand for CDP's `{ value: { value: x } }` field shape. */
const v = (value: unknown) => ({ value });

function node(id: string, role: string, over: Record<string, unknown> = {}) {
  return { nodeId: id, role: v(role), childIds: [], ...over };
}

describe("accessibility snapshot formatting", () => {
  test("renders role, name, value, and flags", () => {
    const tree = {
      nodes: [
        node("1", "RootWebArea", { name: v("Kitchen Sink"), childIds: ["2", "3"] }),
        node("2", "button", {
          name: v("Save"),
          properties: [
            { name: "disabled", value: v(true) },
            { name: "focused", value: v(false) },
          ],
        }),
        node("3", "textbox", { name: v("Search"), value: v("hello") }),
      ],
    };
    expect(formatAxTree(tree)).toBe(
      [
        'RootWebArea "Kitchen Sink"',
        '  button "Save" disabled',
        '  textbox "Search" value="hello"',
      ].join("\n"),
    );
  });

  // The whole point of the AX snapshot is that wrapper divs disappear.
  test("elides structural nodes but keeps their children at the parent's depth", () => {
    const tree = {
      nodes: [
        node("1", "RootWebArea", { childIds: ["2"] }),
        node("2", "generic", { childIds: ["3"] }),
        node("3", "none", { childIds: ["4"] }),
        node("4", "link", { name: v("Docs") }),
      ],
    };
    expect(formatAxTree(tree)).toBe(["RootWebArea", '  link "Docs"'].join("\n"));
  });

  test("elides ignored nodes without losing their subtree", () => {
    const tree = {
      nodes: [
        node("1", "RootWebArea", { childIds: ["2"] }),
        node("2", "banner", { ignored: true, childIds: ["3"] }),
        node("3", "heading", { name: v("Title"), properties: [{ name: "level", value: v(1) }] }),
      ],
    };
    expect(formatAxTree(tree)).toBe(["RootWebArea", '  heading "Title" level=1'].join("\n"));
  });

  test("keeps only the informative properties", () => {
    const tree = {
      nodes: [
        node("1", "checkbox", {
          name: v("Dark mode"),
          properties: [
            { name: "checked", value: v(true) },
            { name: "hidden", value: v(true) },
            { name: "roledescription", value: v("switch") },
          ],
        }),
      ],
    };
    expect(formatAxTree(tree)).toBe('checkbox "Dark mode" checked');
  });

  test("quotes names so multi-word labels stay unambiguous", () => {
    const tree = { nodes: [node("1", "button", { name: v('Say "hi" now') })] };
    expect(formatAxTree(tree)).toBe('button "Say \\"hi\\" now"');
  });

  test("a cyclic tree terminates instead of hanging", () => {
    const tree = {
      nodes: [
        node("1", "RootWebArea", { childIds: ["2"] }),
        node("2", "list", { childIds: ["1"] }),
      ],
    };
    expect(formatAxTree(tree)).toBe(["RootWebArea", "  list"].join("\n"));
  });

  test("truncates a huge tree and says so", () => {
    const ids = Array.from({ length: 900 }, (_, i) => String(i + 2));
    const tree = {
      nodes: [
        node("1", "RootWebArea", { childIds: ids }),
        ...ids.map((id) => node(id, "listitem", { name: v(`row ${id}`) })),
      ],
    };
    const lines = formatAxTree(tree).split("\n");
    expect(lines.length).toBeLessThan(700);
    expect(lines.at(-1)).toContain("truncated");
  });

  test("an empty or malformed payload yields an empty snapshot", () => {
    expect(formatAxTree({ nodes: [] })).toBe("");
    expect(formatAxTree({})).toBe("");
    expect(formatAxTree(null)).toBe("");
    expect(formatAxTree({ nodes: [{ nothing: true }] })).toBe("");
  });

  test("a node without a role still prints", () => {
    expect(formatAxTree({ nodes: [{ nodeId: "1", childIds: [] }] })).toBe("node");
  });
});
