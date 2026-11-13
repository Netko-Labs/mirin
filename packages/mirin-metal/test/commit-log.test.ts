import { describe, expect, test } from "bun:test";
import { type PropCounts, sameProps } from "../src/lib/commit-log.ts";

/** Compare each props object with the one before, as commitUpdate does, with one node's counts. */
function compared(...props: object[]): boolean[] {
  const counts: PropCounts = { propCount: -1, styleCount: -1 };
  return props.slice(1).map((next, index) => sameProps(props[index] as object, next, counts));
}

const noop = (): void => {};

describe("sameProps", () => {
  test("new objects with the same values are the same, a handler for a handler", () => {
    expect(
      compared(
        { testID: "a", onPress: noop, style: { width: 1, color: "#fff" }, children: [1] },
        { testID: "a", onPress: () => {}, style: { width: 1, color: "#fff" }, children: [2] },
        { testID: "a", onPress: () => {}, style: { width: 1, color: "#fff" } },
      ),
    ).toEqual([true, true]);
  });

  test("a key or a style key added or removed differs, however often it was counted", () => {
    const style = { width: 1 };
    expect(
      compared(
        { style: { width: 1 } },
        { style: { width: 1 } },
        { style: { width: 1, height: 2 } },
        { style: { width: 1, height: 2 } },
        { style: { width: 1 } },
        { style: { width: 1 }, testID: "x" },
        { style: { width: 1 }, testID: "x" },
        { style: { width: 1 } },
        { style },
        { style },
        { style: { width: 1, height: undefined } },
        { style: { width: 1, height: undefined } },
        { style: { width: 1 } },
      ),
    ).toEqual([true, false, true, false, false, true, false, true, true, false, true, false]);
  });

  test("a value changed, a style dropped, or a handler gone differs", () => {
    expect(
      compared(
        { style: { width: 1 }, onPress: noop },
        { style: { width: 2 }, onPress: noop },
        { onPress: noop },
        {},
      ),
    ).toEqual([false, false, false]);
  });
});
