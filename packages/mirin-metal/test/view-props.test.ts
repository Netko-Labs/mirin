import { expect, test } from "bun:test";
import { viewHeadJson } from "../src/lib/view-props.ts";
import type { ViewProps } from "../src/types.ts";

const head = (props: ViewProps, root = false) =>
  JSON.parse(viewHeadJson("7", props, root)) as { type: string; props: Record<string, unknown> };

test("a view's fields go out in one order, whatever order its style says them in", () => {
  const style = { backgroundColor: "#fff", padding: 4, flexDirection: "row", gap: 2 } as const;
  const reversed = { gap: 2, flexDirection: "row", padding: 4, backgroundColor: "#fff" } as const;
  expect(viewHeadJson("7", { style }, false)).toBe(
    '{"type":"view","props":{"id":"7","direction":"row","gap":2,"padding":4,"background":"#fff"}}',
  );
  expect(viewHeadJson("7", { style: reversed }, false)).toBe(viewHeadJson("7", { style }, false));
  // The root fills the window, last.
  expect(viewHeadJson("1", {}, true)).toBe('{"type":"view","props":{"id":"1","fill":true}}');
});

test("fields that read together: centering, margins, sizes, grids, overflow", () => {
  expect(head({ style: { justifyContent: "center", alignItems: "center" } }).props).toEqual({
    id: "7",
    center: true,
  });
  expect(head({ style: { alignItems: "center", justifyContent: "space-between" } }).props).toEqual({
    id: "7",
    align: "center",
    justify: "between",
  });
  expect(
    head({ style: { marginTop: "auto", marginLeft: 3, width: "50%", height: 20 } }).props,
  ).toEqual({ id: "7", marginTopAuto: true, marginLeft: 3, widthPercent: 0.5, height: 20 });
  // Template tracks only for a grid; placements at any time.
  expect(head({ style: { gridTemplateColumns: ["1fr"], gridColumn: { span: 2 } } }).props).toEqual({
    id: "7",
    colSpan: 2,
  });
  expect(
    head({ style: { display: "grid", gridTemplateColumns: ["1fr"], overflow: "scroll-both" } })
      .props,
  ).toEqual({ id: "7", scroll: true, scrollX: true, grid: true, gridColumns: ["1fr"] });
  expect(head({ style: { flexShrink: 0, opacity: Number.NaN } }).props).toEqual({
    id: "7",
    shrink: false,
    opacity: null,
  });
});

test("handlers and flags say only that they are there; accessibility is gathered", () => {
  const props: ViewProps = {
    onPress: () => {},
    focusGroup: true,
    selectsOnFocus: true,
    occlude: false,
    accessibilityRole: "button",
    accessibilityState: { selected: true },
    testID: "x",
  };
  expect(viewHeadJson("7", props, false)).toBe(
    '{"type":"view","props":{"id":"7","focusGroup":true,"selectsOnFocus":true,"onPress":true,"access":{"role":"button","selected":true}}}',
  );
  expect(head({ selectsOnFocus: true }).props).toEqual({ id: "7" });
});
