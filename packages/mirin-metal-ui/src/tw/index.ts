/**
 * Tailwind class strings → Metal styles. Variants are evaluated against the
 * element's attributes (see `variants.ts`); utilities are translated by
 * `utilities.ts`. A class string is split once and its style kept per theme
 * and variant outcome (`cache.ts`): elements read the kept style through
 * `styleFor`; `translate` builds a fresh one a caller may change.
 */

import type { ThemeTokens } from "../theme.ts";
import { translateFresh } from "./cache.ts";
import type { TwStyle } from "./utilities.ts";
import type { StyleState } from "./variants.ts";

export { clearStyleCache, styleFor } from "./cache.ts";
export { spacing } from "./scale.ts";
export { color, type Display, type TwStyle } from "./utilities.ts";
export { breakpointFloor, emptyState, type StyleState } from "./variants.ts";

/** Translate a class list under `state`. Later classes win, like Tailwind's cascade order. */
export function translate(
  className: string | undefined,
  theme: ThemeTokens,
  radiusBase: number,
  state: StyleState,
): TwStyle {
  return translateFresh(className, theme, radiusBase, state);
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
