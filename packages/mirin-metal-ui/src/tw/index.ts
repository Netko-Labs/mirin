/**
 * Tailwind class strings → Metal styles. Variants are evaluated against the
 * element's attributes (see `variants.ts`); utilities are translated by
 * `utilities.ts`. Results are memoized per (class string, state signature).
 */

import type { ThemeTokens } from "../theme.ts";
import { applyUtility, emptyStyle, type TwStyle } from "./utilities.ts";
import { resolveVariants, type StyleState, splitVariants } from "./variants.ts";

export { spacing } from "./scale.ts";
export { color, type Display, type TwStyle } from "./utilities.ts";
export { emptyState, type StyleState } from "./variants.ts";

/** Translate a class list under `state`. Later classes win, like Tailwind's cascade order. */
export function translate(
  className: string | undefined,
  theme: ThemeTokens,
  radiusBase: number,
  state: StyleState,
): TwStyle {
  const acc = emptyStyle();
  if (!className) return acc;
  for (const raw of className.split(/\s+/)) {
    if (!raw) continue;
    const parts = splitVariants(raw);
    let utility = parts.pop() ?? "";
    if (utility.startsWith("!")) utility = utility.slice(1);
    if (utility.endsWith("!")) utility = utility.slice(0, -1);
    const target = parts.length === 0 ? "self" : resolveVariants(parts, state);
    if (target === "skip") continue;
    applyUtility(utility, target, theme, radiusBase, acc);
  }
  if (acc.leading !== undefined && acc.text.lineHeight === undefined) {
    acc.text.lineHeight = Math.round((acc.text.fontSize ?? 14) * acc.leading);
  }
  return acc;
}

/**
 * Compatibility entry used by components that only need the three style
 * buckets: `tw(theme, ...classes)` with the default (stateless) evaluation.
 */
export function tw(
  theme: ThemeTokens,
  ...classes: Array<string | false | null | undefined>
): TwStyle {
  const joined = classes.filter((entry): entry is string => typeof entry === "string").join(" ");
  return translate(joined, theme, 8, {
    attrs: {},
    groups: {},
    dark: true,
    viewportWidth: 1280,
  });
}
