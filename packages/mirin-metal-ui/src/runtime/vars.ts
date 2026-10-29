/**
 * CSS custom properties, the way shadcn components use them: an element
 * defines `--name` through `style={{ "--sidebar-width": "16rem" }}` or an
 * arbitrary class (`[--cell-size:--spacing(8)]`), descendants inherit it, and
 * utilities read it back (`w-(--sidebar-width)`, `bg-(--color-bg)`,
 * `w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]`). References are
 * substituted into the class string as arbitrary values (`w-[256px]`,
 * `bg-[#2563eb]`) before the Tailwind engine sees it. Theme tokens
 * (`var(--primary)`, `var(--chart-1)`) resolve from the active theme.
 */

import { createContext } from "react";
import type { ThemeTokens } from "../theme.ts";
import { SPACING_UNIT } from "../tw/scale.ts";
import { splitVariants } from "../tw/variants.ts";

export type CssVars = Readonly<Record<string, string>>;

export const VarsContext = createContext<CssVars>({});

function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** The value of `--name` from inherited vars, then the theme. */
function lookup(name: string, vars: CssVars, theme: ThemeTokens): string | undefined {
  const own = vars[name];
  if (own !== undefined) return own;
  return (theme as unknown as Record<string, string | undefined>)[camel(name.slice(2))];
}

/** A length in px, or undefined. Accepts `12px`, `1.5rem`, `0`. */
function toPx(value: string): number | undefined {
  const match = value.trim().match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!match) return undefined;
  return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
}

/** Split `a+b-c*-1` into signed terms; a sign right after `*`/`/` belongs to its factor. */
function terms(expression: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of expression.replace(/\s+/g, "")) {
    const last = current[current.length - 1];
    if ((ch === "+" || ch === "-") && current !== "" && last !== "*" && last !== "/") {
      out.push(current);
      current = ch === "-" ? "-" : "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Sum of `+`/`-` separated px terms (each may carry `*N` or `/N`), or undefined. */
function evaluateSum(expression: string): number | undefined {
  let total = 0;
  for (const term of terms(expression)) {
    const sign = term.startsWith("-") ? -1 : 1;
    const parts = term.replace(/^[+-]/, "").split(/(?=[*/])/);
    const px = toPx(parts[0] ?? "");
    if (px === undefined) return undefined;
    let value = px;
    for (const part of parts.slice(1)) {
      const n = Number(part.slice(1));
      if (!Number.isFinite(n) || (part[0] === "/" && n === 0)) return undefined;
      value = part[0] === "*" ? value * n : value / n;
    }
    total += sign * value;
  }
  return total;
}

/**
 * Resolve a CSS value: `var(--x)`, `(--x)`, `--spacing(N)`, `calc(…)` of
 * lengths. Returns the substituted text (a color, `NNpx`, or the literal).
 */
export function resolveValue(
  raw: string,
  vars: CssVars,
  theme: ThemeTokens,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined;
  let value = raw.trim();
  let failed = false;
  value = value.replace(
    /--spacing\((-?\d*\.?\d+)\)/g,
    (_, n: string) => `${Number(n) * SPACING_UNIT}px`,
  );
  value = value.replace(/var\((--[\w-]+)(?:,([^)]*))?\)|\((--[\w-]+)\)/g, (_, a, fallback, b) => {
    const name = (a ?? b) as string;
    const found = lookup(name, vars, theme) ?? (fallback as string | undefined);
    const resolved = found === undefined ? undefined : resolveValue(found, vars, theme, depth + 1);
    if (resolved === undefined) failed = true;
    return resolved ?? "";
  });
  if (failed) return undefined;
  const calc = value.match(/^calc\((.*)\)$/);
  if (calc) {
    const inner = (calc[1] ?? "").replace(/[()]/g, "");
    const px = evaluateSum(inner);
    return px === undefined ? undefined : `${px}px`;
  }
  return value;
}

/** The custom properties an element defines through `style` and `[--x:value]` classes. */
export function ownVars(
  className: string | undefined,
  style: Record<string, unknown> | undefined,
  inherited: CssVars,
  theme: ThemeTokens,
): Record<string, string> | null {
  let out: Record<string, string> | null = null;
  const define = (name: string, value: string) => {
    const resolved = resolveValue(value, { ...inherited, ...out }, theme);
    if (resolved === undefined) return;
    out ??= {};
    out[name] = resolved;
  };
  if (className?.includes("[--")) {
    for (const token of className.split(/\s+/)) {
      const match = token.match(/^\[(--[\w-]+):(.+)\]$/);
      if (match) define(match[1] ?? "", (match[2] ?? "").replace(/_/g, " "));
    }
  }
  if (style) {
    for (const [key, value] of Object.entries(style)) {
      if (!key.startsWith("--")) continue;
      if (typeof value === "string" || typeof value === "number") define(key, String(value));
    }
  }
  return out;
}

/** True when a class string reads a custom property. */
export function readsVars(className: string | undefined): boolean {
  return !!className && (className.includes("(--") || className.includes("var(--"));
}

/** Rewrite `util-(--x)` and `util-[…var(--x)…]` tokens into resolved arbitrary values. */
export function substituteVars(className: string, vars: CssVars, theme: ThemeTokens): string {
  return className
    .split(/\s+/)
    .map((token) => {
      if (token.startsWith("[--") || !(token.includes("(--") || token.includes("var(--"))) {
        return token;
      }
      const parts = splitVariants(token);
      const utility = parts.pop() ?? "";
      const shorthand = utility.match(/^(-?[a-z][\w-]*?-)\((--[\w-]+)\)$/);
      const bracket = utility.match(/^(-?[a-z][\w-]*?-)\[(.+)\]$/);
      const prefix = shorthand?.[1] ?? bracket?.[1];
      const expression = shorthand ? `var(${shorthand[2]})` : bracket?.[2]?.replace(/_/g, " ");
      if (prefix === undefined || expression === undefined) return token;
      const resolved = resolveValue(expression, vars, theme);
      if (resolved === undefined || /\s/.test(resolved)) return token;
      return [...parts, `${prefix}[${resolved}]`].join(":");
    })
    .join(" ");
}
