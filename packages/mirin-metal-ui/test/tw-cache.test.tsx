import { beforeEach, describe, expect, test } from "bun:test";
import { type NativeEvent, type NativeTransport, render } from "@mirinjs/metal";
import { ThemeProvider } from "../src/provider.tsx";
import { createTheme, darkTokens, lightTokens, useStyleTheme, useTheme } from "../src/theme.ts";
import {
  breakpointFloor,
  clearStyleCache,
  type StyleState,
  styleFor,
  translate,
} from "../src/tw/index.ts";

const state = (overrides: Partial<StyleState> = {}): StyleState => ({
  attrs: {},
  groups: {},
  dark: true,
  viewportWidth: 1280,
  ...overrides,
});

beforeEach(() => clearStyleCache());

describe("kept styles", () => {
  test("one class string under one theme is one style, and it cannot be written to", () => {
    const a = styleFor("flex gap-2 bg-primary text-sm", darkTokens, 10, state());
    const b = styleFor("flex gap-2 bg-primary text-sm", darkTokens, 10, state());
    expect(b).toBe(a);
    expect(a.view.backgroundColor).toBe(darkTokens.primary);
    expect(Object.isFrozen(a) && Object.isFrozen(a.view) && Object.isFrozen(a.text)).toBe(true);
    expect(() => {
      a.view.gap = 99;
    }).toThrow();
  });

  test("it is what translate builds, which stays the caller's own", () => {
    for (const className of [
      "flex flex-col gap-0.5 overflow-y-auto p-2",
      "px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground uppercase leading-6",
      "hover:bg-sidebar-accent data-[state=open]:bg-accent md:w-72 dark:border-input !p-4",
      "grid grid-cols-[1fr_auto] has-[>svg]:px-3 group-data-[collapsible=icon]:hidden",
      "",
    ]) {
      for (const each of [
        state(),
        state({ attrs: { "data-state": "open" }, viewportWidth: 500 }),
      ]) {
        const fresh = translate(className, darkTokens, 10, each);
        expect(styleFor(className, darkTokens, 10, each)).toEqual(fresh);
        expect(Object.isFrozen(fresh)).toBe(false);
        expect(translate(className, darkTokens, 10, each)).not.toBe(fresh);
      }
    }
  });

  test("a theme's styles are its own: other tokens or another radius make another style", () => {
    const dark = styleFor("bg-background rounded-lg", darkTokens, 10, state());
    const light = styleFor("bg-background rounded-lg", lightTokens, 10, state({ dark: false }));
    expect(dark.view.backgroundColor).toBe(darkTokens.background);
    expect(light.view.backgroundColor).toBe(lightTokens.background);
    expect(styleFor("bg-background rounded-lg", darkTokens, 4, state()).view.borderRadius).not.toBe(
      dark.view.borderRadius,
    );
    // Back to the first theme: its style is still there.
    expect(styleFor("bg-background rounded-lg", darkTokens, 10, state())).toBe(dark);
  });

  test("a theme made again with the same tokens finds the styles made under the first", () => {
    const first = createTheme("zinc", "dark");
    const again = createTheme("zinc", "dark");
    expect(again.colors).not.toBe(first.colors);
    const style = styleFor("border bg-card", first.colors, first.radius, state());
    expect(styleFor("border bg-card", again.colors, again.radius, state())).toBe(style);
    const other = createTheme("blue", "dark");
    expect(styleFor("border bg-card", other.colors, other.radius, state())).not.toBe(style);
  });

  test("variants: one style per outcome, whatever else the element's state holds", () => {
    const className = "bg-card data-[state=open]:bg-accent disabled:opacity-50";
    const closed = styleFor(
      className,
      darkTokens,
      10,
      state({ attrs: { "data-state": "closed" } }),
    );
    const open = styleFor(className, darkTokens, 10, state({ attrs: { "data-state": "open" } }));
    expect(closed.view.backgroundColor).toBe(darkTokens.card);
    expect(open.view.backgroundColor).toBe(darkTokens.accent);
    expect(open).not.toBe(closed);
    // An attribute no variant of this class reads changes nothing.
    const noisy = state({ attrs: { "data-state": "open", "data-slot": "item", role: "tab" } });
    expect(styleFor(className, darkTokens, 10, noisy)).toBe(open);
    const disabled = state({ attrs: { "data-state": "open", disabled: true } });
    expect(styleFor(className, darkTokens, 10, disabled).view.opacity).toBe(0.5);
    expect(open.view.opacity).toBeUndefined();
  });

  test("dark: and breakpoints are outcomes too", () => {
    const className = "p-2 md:p-6 dark:bg-input";
    const narrow = styleFor(className, darkTokens, 10, state({ viewportWidth: 500 }));
    const wide = styleFor(className, darkTokens, 10, state({ viewportWidth: 900 }));
    expect(narrow.view.padding).toBe(8);
    expect(wide.view.padding).toBe(24);
    expect(styleFor(className, darkTokens, 10, state({ viewportWidth: 1000 }))).toBe(wide);
    const day = styleFor(className, darkTokens, 10, state({ viewportWidth: 900, dark: false }));
    expect(day.view.backgroundColor).toBeUndefined();
    expect(wide.view.backgroundColor).toBe(darkTokens.input);
  });

  test("more class strings than are kept still translate right", () => {
    for (let index = 0; index < 9000; index += 1) {
      expect(styleFor(`w-[${index}px]`, darkTokens, 10, state()).view.width).toBe(index);
    }
    expect(styleFor("w-[3px]", darkTokens, 10, state()).view.width).toBe(3);
  });
});

describe("the breakpoint a width has reached", () => {
  test("answers every breakpoint variant as the width itself does", () => {
    const className =
      "sm:p-1 md:p-2 lg:p-3 xl:p-4 2xl:p-5 max-sm:gap-1 max-md:gap-2 max-lg:gap-3 max-xl:gap-4 max-2xl:gap-5";
    for (let width = 0; width <= 1700; width += 1) {
      const floor = breakpointFloor(width);
      expect(floor).toBeLessThanOrEqual(width);
      if (
        width % 16 === 0 ||
        [639, 640, 767, 768, 1023, 1024, 1279, 1280, 1535, 1536].includes(width)
      ) {
        expect(translate(className, darkTokens, 10, state({ viewportWidth: floor }))).toEqual(
          translate(className, darkTokens, 10, state({ viewportWidth: width })),
        );
      }
    }
    expect([0, 639, 640, 800, 1024, 1300, 4000].map(breakpointFloor)).toEqual([
      0, 0, 640, 768, 1024, 1280, 1536,
    ]);
  });
});

describe("a window resized", () => {
  test("re-renders elements only when a breakpoint is crossed; useTheme() has the width", async () => {
    const listeners: Array<(event: NativeEvent) => void> = [];
    let tree = "";
    const transport: NativeTransport = {
      send(line) {
        if (!line.startsWith('{"patch"')) tree = line;
      },
      onEvent(listener) {
        listeners.push(listener);
      },
      onClose() {},
      simulate() {},
      close() {},
    };
    const renders = { styled: 0, exact: 0 };
    let width = 0;
    let padding: unknown;
    function Styled() {
      renders.styled += 1;
      const theme = useStyleTheme();
      padding = styleFor("p-2 lg:p-8", theme.colors, theme.radius, {
        attrs: {},
        groups: {},
        dark: theme.mode === "dark",
        viewportWidth: theme.viewportWidth,
      }).view.padding;
      return null;
    }
    function Exact() {
      renders.exact += 1;
      width = useTheme().viewportWidth;
      return null;
    }
    const root = render(
      <ThemeProvider>
        <div className="p-2">
          <Styled />
          <Exact />
        </div>
      </ThemeProvider>,
      transport,
    );
    await Bun.sleep(10);
    const layer = tree.match(/"id":"(\d+)"[^{}]*?"onLayout":true/)?.[1];
    if (!layer) throw new Error("no layout view in the tree");
    const resize = async (to: number) => {
      for (const listener of listeners) {
        listener({ type: "resize", nodeId: layer, bounds: { x: 0, y: 0, width: to, height: 800 } });
      }
      await Bun.sleep(10);
    };
    await resize(1300);
    const before = { ...renders };
    expect(width).toBe(1300);
    expect(padding).toBe(32);
    await resize(1301);
    await resize(1420);
    expect(width).toBe(1420);
    expect(renders.exact).toBe(before.exact + 2);
    expect(renders.styled).toBe(before.styled);
    await resize(900);
    expect(renders.styled).toBe(before.styled + 1);
    expect(padding).toBe(8);
    root.unmount();
  });
});
