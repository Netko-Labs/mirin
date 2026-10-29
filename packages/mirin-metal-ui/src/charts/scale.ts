/** Number scales and color resolution for the recharts subset. */

import { type CssVars, resolveValue } from "../runtime/vars.ts";
import type { ThemeTokens } from "../theme.ts";

/** recharts-style "nice" ticks from 0 to at least `max` (`tickCount` ticks). */
export function niceTicks(max: number, tickCount = 5): number[] {
  const intervals = Math.max(1, tickCount - 1);
  if (!(max > 0)) return Array.from({ length: intervals + 1 }, (_, i) => i);
  const raw = max / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.ceil(raw / magnitude) * magnitude;
  return Array.from({ length: intervals + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

/** A fill/stroke string (`#hex`, `var(--color-desktop)`, `hsl(var(--chart-1))`) → `#hex`. */
export function resolveColor(
  value: unknown,
  vars: CssVars,
  theme: ThemeTokens,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const resolved = resolveValue(value, vars, theme);
  if (!resolved) return undefined;
  const wrapped = resolved.match(/^(?:hsla?|rgba?|oklch)\((#[0-9a-fA-F]{3,8})\)$/);
  const hex = wrapped?.[1] ?? resolved;
  return /^#[0-9a-fA-F]{3,8}$/.test(hex) ? hex : undefined;
}
