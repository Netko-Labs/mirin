/**
 * Class strings translated once. A class string is split into its tokens
 * once, whatever the theme; its style is then kept per theme and per what its
 * variants resolved to (`data-[state=open]:`, `md:`, `dark:` against the
 * element's state), so the 240 rows of a list that share one class string
 * share one style, and a theme toggled back finds its styles made.
 *
 * `styleFor` returns the kept style itself, frozen: read it, spread it,
 * never write to it. `translate` (the public entry) builds a fresh one.
 */

import type { ThemeTokens } from "../theme.ts";
import { applyUtility, emptyStyle, type TwStyle } from "./utilities.ts";
import { resolveVariants, type StyleState, splitVariants, type VariantTarget } from "./variants.ts";

interface Token {
  /** The variant chain before the utility (`hover:`, `data-[state=open]:`), or null. */
  variants: string[] | null;
  utility: string;
}

interface Parsed {
  tokens: Token[];
  /** Whether any token has variants: its style then depends on the element's state. */
  conditional: boolean;
}

/** Class strings an app writes are finite; ones it computes (a width per frame) are not. */
const MAX_PARSED = 8192;
const MAX_STYLES = 8192;
/** Themes whose styles are kept: light and dark of a few palettes. */
const MAX_THEMES = 8;

const parsed = new Map<string, Parsed>();
/** Per theme (its tokens' values and the radius): the styles made under it. */
const themes = new Map<string, Styles>();
/** The same, by the tokens object and the radius: no key to build for a theme seen before. */
const scopes = new WeakMap<ThemeTokens, Map<number, Styles>>();

function parse(className: string): Parsed {
  const known = parsed.get(className);
  if (known) return known;
  const tokens: Token[] = [];
  let conditional = false;
  for (const raw of className.split(/\s+/)) {
    if (!raw) continue;
    const parts = splitVariants(raw);
    let utility = parts.pop() ?? "";
    if (utility.startsWith("!")) utility = utility.slice(1);
    if (utility.endsWith("!")) utility = utility.slice(0, -1);
    if (parts.length > 0) conditional = true;
    tokens.push({ variants: parts.length > 0 ? parts : null, utility });
  }
  const entry = { tokens, conditional };
  if (parsed.size >= MAX_PARSED) parsed.clear();
  parsed.set(className, entry);
  return entry;
}

/** Where each token's utility lands under `state` ("self" for one without variants). */
function targetsOf(entry: Parsed, state: StyleState): VariantTarget[] {
  return entry.tokens.map((token) =>
    token.variants ? resolveVariants(token.variants, state) : "self",
  );
}

function build(
  entry: Parsed,
  targets: VariantTarget[] | null,
  theme: ThemeTokens,
  radiusBase: number,
): TwStyle {
  const acc = emptyStyle();
  entry.tokens.forEach((token, index) => {
    const target = targets ? (targets[index] ?? "skip") : "self";
    if (target !== "skip") applyUtility(token.utility, target, theme, radiusBase, acc);
  });
  if (acc.leading !== undefined && acc.text.lineHeight === undefined) {
    acc.text.lineHeight = Math.round((acc.text.fontSize ?? 14) * acc.leading);
  }
  return acc;
}

/** A fresh style for a class list under `state`. Later classes win, like Tailwind's cascade order. */
export function translateFresh(
  className: string | undefined,
  theme: ThemeTokens,
  radiusBase: number,
  state: StyleState,
): TwStyle {
  if (!className) return emptyStyle();
  const entry = parse(className);
  return build(entry, entry.conditional ? targetsOf(entry, state) : null, theme, radiusBase);
}

/** What is kept for one class string under a theme: its style, or one per variant outcome. */
interface Kept {
  plain?: TwStyle;
  byTargets?: Map<string, TwStyle>;
}

type Styles = Map<string, Kept>;

/** The styles kept for a theme: by the values of its tokens, so a theme made again finds them. */
function stylesOf(theme: ThemeTokens, radiusBase: number): Styles {
  // By the object first: every element of every render asks, with the same one.
  let byRadius = scopes.get(theme);
  if (!byRadius) {
    byRadius = new Map();
    scopes.set(theme, byRadius);
  }
  let styles = byRadius.get(radiusBase);
  if (styles) return styles;
  const signature = Object.entries(theme)
    .map(([token, value]) => `${token}=${String(value)}`)
    .join(";");
  const key = `${radiusBase}|${signature}`;
  styles = themes.get(key);
  if (!styles) {
    // The oldest theme goes: a Map keeps the order its keys were added in.
    if (themes.size >= MAX_THEMES) {
      const oldest = themes.keys().next().value;
      if (oldest !== undefined) themes.delete(oldest);
    }
    styles = new Map();
    themes.set(key, styles);
  }
  byRadius.set(radiusBase, styles);
  return styles;
}

function freeze(style: TwStyle): TwStyle {
  Object.freeze(style.view);
  Object.freeze(style.text);
  Object.freeze(style.input);
  Object.freeze(style.svg);
  return Object.freeze(style);
}

const EMPTY = freeze(emptyStyle());

/**
 * The style of a class list under `state`, kept: the same object for the
 * same class string, theme and variant outcomes. Frozen; callers copy what
 * they change.
 */
export function styleFor(
  className: string | undefined,
  theme: ThemeTokens,
  radiusBase: number,
  state: StyleState,
): TwStyle {
  if (!className) return EMPTY;
  const entry = parse(className);
  const styles = stylesOf(theme, radiusBase);
  let kept = styles.get(className);
  if (!kept) {
    if (styles.size >= MAX_STYLES) styles.clear();
    kept = {};
    styles.set(className, kept);
  }
  if (!entry.conditional) {
    kept.plain ??= freeze(build(entry, null, theme, radiusBase));
    return kept.plain;
  }
  const targets = targetsOf(entry, state);
  const outcome = targets.join(" ");
  kept.byTargets ??= new Map();
  let style = kept.byTargets.get(outcome);
  if (!style) {
    style = freeze(build(entry, targets, theme, radiusBase));
    kept.byTargets.set(outcome, style);
  }
  return style;
}

/** Forget every kept class string and style (tests). */
export function clearStyleCache(): void {
  parsed.clear();
  // The scopes by object point into these maps: emptied, not replaced.
  for (const styles of themes.values()) styles.clear();
}
