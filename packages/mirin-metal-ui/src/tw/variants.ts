/**
 * Tailwind variant prefixes (`hover:`, `dark:`, `data-[state=open]:`,
 * `group-data-[collapsible=icon]:`, `md:`) evaluated against the element's
 * own attributes and its ancestors' group state. Interaction-only variants
 * the renderer cannot observe (`focus-visible:`, `active:`) evaluate false,
 * so the resting style is what renders.
 */

/** Attribute bag an element exposes to variants: `data-*`, `aria-*`, `disabled`, … */
export type Attrs = Record<string, unknown>;

/** A descendant an element can match with `has-*` (see `runtime/has.ts`). */
export interface HasEntry {
  tag: string;
  attrs: Attrs;
  /** A direct child (for `has-[>…]`). */
  direct: boolean;
}

export interface StyleState {
  /** The element's own attributes. */
  attrs: Attrs;
  /** Descendants registered for `has-*` variants, when the element uses them. */
  has?: HasEntry[];
  /** Attributes of `group`/`group/<name>` ancestors, keyed by group name ("" = unnamed). */
  groups: Record<string, Attrs>;
  dark: boolean;
  /** Window width in px, for `sm:`/`md:`/… breakpoints. */
  viewportWidth: number;
}

export const emptyState: StyleState = {
  attrs: {},
  groups: {},
  dark: true,
  viewportWidth: 1280,
};

/** Where a utility under a variant should land. */
export type VariantTarget = "self" | "hover" | "placeholder" | "svg" | "skip";

const BREAKPOINTS: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/**
 * The widest breakpoint a window `width` px wide has reached (0 below `sm`).
 * Every breakpoint variant answers the same for it as for the width itself,
 * so styling keyed by it changes only when a breakpoint is crossed.
 */
export function breakpointFloor(width: number): number {
  let floor = 0;
  for (const at of Object.values(BREAKPOINTS)) if (width >= at && at > floor) floor = at;
  return floor;
}

/** Split `a:b:[&_x:y]:util` on top-level colons (brackets protect inner colons). */
export function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "false";
}

/** `data-[state=open]` / `data-disabled` / `aria-[sort=asc]` / `aria-invalid` against attrs. */
function matchAttr(variant: string, attrs: Attrs): boolean | undefined {
  const bracket = variant.match(/^(data|aria)-\[([^=\]]+)(?:=([^\]]*))?\]$/);
  if (bracket) {
    const [, kind, key = "", raw] = bracket;
    const value = attrs[`${kind}-${key}`];
    if (raw === undefined) return truthy(value);
    return String(value) === raw.replace(/^['"]|['"]$/g, "");
  }
  const bare = variant.match(/^(data|aria)-([a-z-]+)$/);
  if (bare) {
    const [, kind, key = ""] = bare;
    const value = attrs[`${kind}-${key}`];
    return kind === "aria" ? value === true || value === "true" : truthy(value);
  }
  return undefined;
}

/** `[&:first-child]` / `[&:not(:last-child)]` / `only`, from Box's sibling attrs. */
function matchChildSelector(variant: string, attrs: Attrs): boolean | undefined {
  if (variant === "only") {
    return attrs["data-metal-first"] === true && attrs["data-metal-last"] === true;
  }
  const selector = variant.match(/^\[&:(?:(not)\(:)?(first|last)-child\)?\]$/);
  if (!selector) return undefined;
  const hit = attrs[`data-metal-${selector[2]}`] === true;
  return selector[1] ? !hit : hit;
}

/**
 * Match a `has-*` selector against one descendant: `[>svg]`,
 * `[>[data-slot=x]]`, `[select:disabled]`, `[:checked]`, or the shorthand
 * forms `data-[slot=x]` / `aria-invalid` / `disabled` / `checked`.
 */
function matchHas(selector: string, entry: HasEntry): boolean {
  const bracket = selector.match(/^\[(.*)\]$/);
  if (!bracket) {
    if (selector === "disabled") return truthy(entry.attrs.disabled);
    if (selector === "checked") return isChecked(entry.attrs);
    return matchAttr(selector, entry.attrs) === true;
  }
  let rest = bracket[1] ?? "";
  if (rest.startsWith(">")) {
    if (!entry.direct) return false;
    rest = rest.slice(1);
  }
  const tag = rest.match(/^[a-z][a-z0-9-]*/)?.[0];
  if (tag) {
    if (entry.tag !== tag) return false;
    rest = rest.slice(tag.length);
  }
  for (const part of rest.match(/\[[^\]]*\]|:[a-z-]+/g) ?? []) {
    if (part === ":disabled") {
      if (!truthy(entry.attrs.disabled) && entry.attrs["aria-disabled"] !== "true") return false;
    } else if (part === ":checked") {
      if (!isChecked(entry.attrs)) return false;
    } else if (part.startsWith("[")) {
      const attr = part.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
      if (!attr) return false;
      const value = entry.attrs[attr[1] ?? ""];
      if (attr[2] === undefined ? !truthy(value) : String(value) !== attr[2]) return false;
    } else {
      return false;
    }
  }
  return true;
}

function isChecked(attrs: Attrs): boolean {
  return (
    truthy(attrs.checked) ||
    attrs["data-state"] === "checked" ||
    attrs["aria-checked"] === true ||
    attrs["aria-checked"] === "true"
  );
}

/** Resolve one variant to a target, or "skip" when it does not apply. */
function evaluate(variant: string, state: StyleState): VariantTarget {
  if (variant.startsWith("has-")) {
    const selector = variant.slice(4);
    return state.has?.some((entry) => matchHas(selector, entry)) ? "self" : "skip";
  }
  // Pointer UI: keyboard focus and Radix's highlight both read as hover.
  if (variant === "hover" || variant === "focus" || variant === "data-[highlighted]")
    return "hover";
  if (variant === "*") return "svg";
  if (variant === "[svg]") return "self";
  if (variant === "placeholder") return "placeholder";
  if (variant === "dark") return state.dark ? "self" : "skip";
  if (variant in BREAKPOINTS) {
    return state.viewportWidth >= (BREAKPOINTS[variant] ?? 0) ? "self" : "skip";
  }
  const max = variant.match(/^max-(sm|md|lg|xl|2xl)$/);
  if (max) return state.viewportWidth < (BREAKPOINTS[max[1] ?? ""] ?? 0) ? "self" : "skip";
  const container = variant.match(/^@(?:max-)?(xs|sm|md|lg|xl|2xl|3xl|4xl)(?:\/\w+)?$/);
  if (container) return variant.startsWith("@max") ? "skip" : "self";
  if (variant === "disabled") return truthy(state.attrs.disabled) ? "self" : "skip";
  if (variant === "enabled") return truthy(state.attrs.disabled) ? "skip" : "self";
  if (variant === "checked") return truthy(state.attrs.checked) ? "self" : "skip";
  // Box sets these from the element's position among its siblings.
  if (variant === "first") return state.attrs["data-metal-first"] === true ? "self" : "skip";
  if (variant === "last") return state.attrs["data-metal-last"] === true ? "self" : "skip";
  if (variant === "invalid") return truthy(state.attrs["aria-invalid"]) ? "self" : "skip";
  if (variant === "open") {
    return truthy(state.attrs.open) || state.attrs["data-state"] === "open" ? "self" : "skip";
  }
  if (variant === "ltr" || variant === "motion-safe") return "self";
  const child = matchChildSelector(variant, state.attrs);
  if (child !== undefined) return child ? "self" : "skip";
  const own = matchAttr(variant, state.attrs);
  if (own !== undefined) return own ? "self" : "skip";

  const group = variant.match(/^group-(.+?)(?:\/([\w-]+))?$/);
  if (group) {
    const [, inner = "", name = ""] = group;
    const attrs = state.groups[name];
    if (!attrs) return "skip";
    if (inner === "hover" || inner === "focus" || inner === "focus-visible") return "skip";
    if (inner === "disabled") return truthy(attrs.disabled) ? "self" : "skip";
    const matched = matchAttr(inner, attrs);
    return matched ? "self" : "skip";
  }
  if (/^\[&[_>]?(svg|.*svg)/.test(variant) || variant === "*:[svg]") return "svg";
  return "skip";
}

/**
 * Resolve a token's variant chain. Returns the target for its utility, or
 * "skip". Multiple variants must all apply; at most one may redirect.
 */
export function resolveVariants(variants: string[], state: StyleState): VariantTarget {
  let target: VariantTarget = "self";
  for (const variant of variants) {
    const result = evaluate(variant, state);
    if (result === "skip") return "skip";
    if (result !== "self") {
      if (target !== "self") return "skip";
      target = result;
    }
  }
  return target;
}
