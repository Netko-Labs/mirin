import { describe, expect, test } from "bun:test";
import { cn, cva } from "../src/lib/cn.ts";
import { darkTokens } from "../src/theme.ts";
import { color, spacing, tw } from "../src/tw.ts";

describe("tw", () => {
  test("translates layout, spacing, and sizing", () => {
    const { view } = tw(
      darkTokens,
      "flex flex-row items-center justify-between gap-2 px-4 py-2 h-9 w-full",
    );
    expect(view).toEqual({
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      height: 36,
      flex: 1,
    });
  });

  test("resolves theme tokens, alpha, palette, and arbitrary colors", () => {
    expect(color("primary", darkTokens)).toBe(darkTokens.primary);
    expect(color("muted-foreground", darkTokens)).toBe(darkTokens.mutedForeground);
    expect(color("primary/50", darkTokens)).toBe(`${darkTokens.primary}80`);
    expect(color("zinc-800", darkTokens)).toBe("#27272a");
    expect(color("[#ec4899]", darkTokens)).toBe("#ec4899");
    expect(color("nonsense", darkTokens)).toBeUndefined();
  });

  test("maps backgrounds, borders, radii, and hover backgrounds", () => {
    const { view } = tw(
      darkTokens,
      "rounded-md border bg-card hover:bg-accent border-destructive/50",
    );
    expect(view.borderRadius).toBe(6);
    expect(view.borderWidth).toBe(1);
    expect(view.backgroundColor).toBe(darkTokens.card);
    expect(view.hoverBackgroundColor).toBe(darkTokens.accent);
    expect(view.borderColor).toBe(`${darkTokens.destructive}80`);
  });

  test("maps typography to text and input styles", () => {
    const { text, input } = tw(
      darkTokens,
      "text-sm font-medium text-muted-foreground font-mono text-center",
    );
    expect(text).toEqual({
      fontSize: 14,
      fontWeight: "medium",
      color: darkTokens.mutedForeground,
      fontFamily: "monospace",
      textAlign: "center",
    });
    expect(input.fontSize).toBe(14);
    expect(input.color).toBe(darkTokens.mutedForeground);
  });

  test("ignores web-only utilities and non-hover variants", () => {
    const { view, text } = tw(
      darkTokens,
      "transition-all focus-visible:ring-2 md:block sr-only data-[state=open]:bg-accent",
    );
    expect(view).toEqual({});
    expect(text).toEqual({});
  });

  test("positions absolute boxes and parses arbitrary px values", () => {
    const { view } = tw(darkTokens, "absolute top-2 right-2 w-[448px] text-[13px]");
    expect(view).toEqual({ position: "absolute", top: 8, right: 8, width: 448 });
    expect(spacing("1.5")).toBe(6);
    expect(spacing("px")).toBe(1);
  });
});

describe("cn and cva", () => {
  test("cn flattens and skips falsy values", () => {
    expect(cn("a", false, ["b", null, ["c"]], undefined)).toBe("a b c");
  });

  test("cva applies defaults, overrides, and className", () => {
    const variants = cva("base", {
      variants: {
        variant: { default: "v-default", outline: "v-outline" },
        size: { sm: "s-sm", lg: "s-lg" },
      },
      defaultVariants: { variant: "default", size: "sm" },
    });
    expect(variants()).toBe("base v-default s-sm");
    expect(variants({ variant: "outline", className: "extra" })).toBe("base v-outline s-sm extra");
    expect(variants({ size: "lg" })).toBe("base v-default s-lg");
  });
});
