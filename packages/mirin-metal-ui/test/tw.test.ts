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
