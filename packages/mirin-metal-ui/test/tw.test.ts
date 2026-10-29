import { describe, expect, test } from "bun:test";
import { darkTokens } from "../src/theme.ts";
import { translate } from "../src/tw/index.ts";

const style = (className: string) =>
  translate(className, darkTokens, 10, { attrs: {}, groups: {}, dark: true, viewportWidth: 1280 });

describe("flex utilities", () => {
  test("flex-1 grows from a zero basis, like CSS flex: 1 1 0%", () => {
    expect(style("flex-1").view.flex).toBe(1);
    expect(style("flex-1").view.flexGrow).toBeUndefined();
  });

  test("grow and flex-auto grow from the content size", () => {
    expect(style("grow").view.flexGrow).toBe(1);
    expect(style("flex-auto").view.flexGrow).toBe(1);
    expect(style("grow").view.flex).toBeUndefined();
  });

  test("grow-0 stops both", () => {
    const view = style("flex-1 grow grow-0").view;
    expect(view.flex).toBe(0);
    expect(view.flexGrow).toBe(0);
  });
});

describe("grid utilities", () => {
  test("grid-cols-N is N equal minmax(0, 1fr) tracks", () => {
    expect(style("grid grid-cols-3").view.gridTemplateColumns).toEqual([
      { min: 0, max: "1fr" },
      { min: 0, max: "1fr" },
      { min: 0, max: "1fr" },
    ]);
  });

  test("arbitrary track lists parse px, fr, auto, minmax, and repeat", () => {
    expect(style("grid-cols-[16px_1fr_auto]").view.gridTemplateColumns).toEqual([
      16,
      "1fr",
      "auto",
    ]);
    expect(style("grid-cols-[repeat(2,minmax(0,1fr))_auto]").view.gridTemplateColumns).toEqual([
      { min: 0, max: "1fr" },
      { min: 0, max: "1fr" },
      "auto",
    ]);
  });

  test("placement and inline-axis alignment", () => {
    const view = style("col-start-2 col-span-2 row-span-2 justify-self-end").view;
    expect(view.gridColumn).toEqual({ start: 2, span: 2 });
    expect(view.gridRow).toEqual({ span: 2 });
    expect(view.justifySelf).toBe("flex-end");
  });

  test("gap-x and gap-y set one axis each", () => {
    expect(style("gap-x-2 gap-y-0.5").view).toMatchObject({ columnGap: 8, rowGap: 2 });
  });
});

describe("width utilities", () => {
  test("the later of w-fit and w-full wins", () => {
    expect(style("w-fit w-full").fitWidth).toBe(false);
    expect(style("w-fit w-full").view.width).toBe("100%");
    expect(style("w-full w-fit").fitWidth).toBe(true);
    expect(style("w-full w-fit").view.width).toBeUndefined();
  });
});

describe("has-* variants", () => {
  const withHas = (
    className: string,
    has: Array<{ tag: string; attrs: Record<string, unknown>; direct: boolean }>,
  ) =>
    translate(className, darkTokens, 10, {
      attrs: {},
      groups: {},
      dark: true,
      viewportWidth: 1280,
      has,
    });

  test("has-[>svg] matches a direct svg child only", () => {
    const direct = withHas("has-[>svg]:px-3", [{ tag: "svg", attrs: {}, direct: true }]);
    const deep = withHas("has-[>svg]:px-3", [{ tag: "svg", attrs: {}, direct: false }]);
    expect(direct.view.paddingHorizontal ?? direct.view.paddingLeft).toBe(12);
    expect(deep.view.paddingHorizontal ?? deep.view.paddingLeft).toBeUndefined();
  });

  test("has-data-[slot=x] and attribute selectors match descendants", () => {
    const entry = { tag: "div", attrs: { "data-slot": "card-action" }, direct: false };
    expect(withHas("has-data-[slot=card-action]:gap-4", [entry]).view.gap).toBe(16);
    expect(withHas("has-[[data-slot=card-action]]:gap-4", [entry]).view.gap).toBe(16);
    expect(withHas("has-data-[slot=other]:gap-4", [entry]).view.gap).toBeUndefined();
  });
});
