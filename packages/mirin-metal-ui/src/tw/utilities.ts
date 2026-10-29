/**
 * One Tailwind utility → its effect on the style accumulator. Covers the
 * utilities shadcn components and examples use; anything else (transitions,
 * rings, cursors, z-index, transforms) is ignored on purpose.
 */

import type { TextInputStyle, TextStyle, ViewStyle } from "@mirinjs/metal";
import type { ThemeTokens } from "../theme.ts";
import { applyGridUtility } from "./grid.ts";
import { fraction, LEADING, NAMED_SIZES, PALETTE, radius, spacing, TEXT_SIZES } from "./scale.ts";
import type { VariantTarget } from "./variants.ts";

export type Display =
  | "block"
  | "flex"
  | "inline-flex"
  | "grid"
  | "inline-grid"
  | "inline"
  | "inline-block"
  | "none"
  | "contents";

/** Everything a class list resolves to. */
export interface TwStyle {
  view: ViewStyle;
  text: TextStyle;
  input: TextInputStyle;
  display?: Display;
  /** Set by `flex-row`/`flex-col`; otherwise `flex` means row, block means column. */
  direction?: "row" | "column";
  /** `sr-only` or `hidden`: render nothing. */
  hidden: boolean;
  spaceX?: number;
  spaceY?: number;
  textTransform?: "uppercase" | "lowercase" | "capitalize";
  /** One line, ellipsis (`truncate`, `line-clamp-1`). */
  truncate: boolean;
  /** `leading-*` keyword multiplier, resolved against the font size. */
  leading?: number;
  /** Set when this element is a `group` (`""`) or `group/<name>`. */
  group?: string;
  /** Icon defaults for descendant icons (`[&_svg]:size-4`, `[&_svg]:text-…`). */
  svg: { size?: number; color?: string };
  objectFit?: "cover" | "contain";
  listStyle?: "disc" | "decimal";
  pointerEventsNone: boolean;
  /** `w-fit`/`w-max`/`w-min`: size to content instead of stretching across a column. */
  fitWidth?: boolean;
}

export function emptyStyle(): TwStyle {
  return {
    view: {},
    text: {},
    input: {},
    hidden: false,
    truncate: false,
    svg: {},
    pointerEventsNone: false,
  };
}

/** `muted-foreground` → `mutedForeground`, `chart-1` → `chart1`. */
function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** Resolve a color token: theme token, palette shade, `[#hex]`, with `/alpha`. */
export function color(token: string, theme: ThemeTokens): string | undefined {
  const slash = token.lastIndexOf("/");
  const hasAlpha = slash > 0 && !token.startsWith("[");
  const name = hasAlpha ? token.slice(0, slash) : token;
  const alphaToken = hasAlpha ? token.slice(slash + 1) : undefined;
  let base: string | undefined;
  const arbitrary = name.match(/^\[(#[0-9a-fA-F]{3,8})\]$/);
  if (arbitrary) base = arbitrary[1];
  else {
    const themed = (theme as unknown as Record<string, string | undefined>)[camel(name)];
    base = themed ?? PALETTE[name];
  }
  if (!base) return undefined;
  if (alphaToken === undefined) return base;
  const bracket = alphaToken.match(/^\[(\d*\.?\d+)\]$/);
  const alpha = bracket ? Number(bracket[1]) : Number(alphaToken) / 100;
  if (!Number.isFinite(alpha)) return base;
  const hex = base.length === 4 ? `#${[...base.slice(1)].map((c) => c + c).join("")}` : base;
  const existing = hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1;
  const a = Math.round(Math.max(0, Math.min(1, alpha * existing)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex.slice(0, 7)}${a}`;
}

type Side = "top" | "bottom" | "left" | "right";
const PADDING_KEYS: Record<Side, keyof ViewStyle> = {
  top: "paddingTop",
  bottom: "paddingBottom",
  left: "paddingLeft",
  right: "paddingRight",
};
const BORDER_KEYS: Record<Side, keyof ViewStyle> = {
  top: "borderTopWidth",
  bottom: "borderBottomWidth",
  left: "borderLeftWidth",
  right: "borderRightWidth",
};

function sidesOf(axis: string): Side[] {
  switch (axis) {
    case "t":
      return ["top"];
    case "b":
      return ["bottom"];
    case "l":
    case "s":
      return ["left"];
    case "r":
    case "e":
      return ["right"];
    case "x":
      return ["left", "right"];
    case "y":
      return ["top", "bottom"];
    default:
      return ["top", "bottom", "left", "right"];
  }
}

/** A length for width/height: px, or a percent string. */
function length(token: string): number | `${number}%` | undefined {
  if (token === "full" || token === "screen" || token === "dvh" || token === "svh") return "100%";
  const named = NAMED_SIZES[token];
  if (named !== undefined) return named;
  const frac = fraction(token);
  if (frac !== undefined) return `${Math.round(frac * 10000) / 100}%`;
  return spacing(token);
}

function set<K extends keyof ViewStyle>(style: ViewStyle, key: K, value: ViewStyle[K]): void {
  style[key] = value;
}

/** Apply one utility (variants already resolved to `target`). */
export function applyUtility(
  rawToken: string,
  target: VariantTarget,
  theme: ThemeTokens,
  radiusBase: number,
  acc: TwStyle,
): void {
  const negative = rawToken.startsWith("-");
  const token = negative ? rawToken.slice(1) : rawToken;
  const sign = negative ? -1 : 1;
  const { view, text, input } = acc;

  if (target === "hover") {
    const bg = token.match(/^bg-(.+)$/);
    if (bg) {
      const resolved = color(bg[1] ?? "", theme);
      if (resolved) view.hoverBackgroundColor = resolved;
    }
    return;
  }
  if (target === "placeholder") {
    const placeholder = token.match(/^text-(.+)$/);
    if (placeholder) {
      const resolved = color(placeholder[1] ?? "", theme);
      if (resolved) input.placeholderColor = resolved;
    }
    return;
  }
  if (target === "svg") {
    const size = token.match(/^size-(.+)$/);
    if (size) acc.svg.size = spacing(size[1] ?? "") ?? acc.svg.size;
    const tint = token.match(/^text-(.+)$/);
    if (tint) acc.svg.color = color(tint[1] ?? "", theme) ?? acc.svg.color;
    return;
  }

  switch (token) {
    case "flex":
    case "inline-flex":
    case "grid":
    case "inline-grid":
    case "block":
    case "inline":
    case "inline-block":
    case "contents":
      // A later display utility (`hidden sm:flex`) undoes `hidden`, not `sr-only`.
      if (acc.display === "none") acc.hidden = false;
      acc.display = token;
      return;
    case "hidden":
      acc.hidden = true;
      acc.display = "none";
      return;
    case "sr-only":
      acc.hidden = true;
      return;
    case "not-sr-only":
      acc.hidden = false;
      return;
    case "invisible":
      view.opacity = 0;
      return;
    case "flex-row":
    case "flex-row-reverse":
      acc.direction = "row";
      return;
    case "flex-col":
    case "flex-col-reverse":
      acc.direction = "column";
      return;
    case "flex-wrap":
      view.flexWrap = "wrap";
      return;
    case "flex-nowrap":
      view.flexWrap = "nowrap";
      return;
    case "flex-1":
      view.flex = 1;
      return;
    // Grow from the content size (flex-basis auto).
    case "flex-auto":
    case "grow":
      view.flexGrow = 1;
      return;
    case "grow-0":
      view.flex = 0;
      view.flexGrow = 0;
      return;
    case "flex-none":
    case "shrink-0":
      view.flexShrink = 0;
      return;
    case "shrink":
      view.flexShrink = 1;
      return;
    case "items-center":
      view.alignItems = "center";
      return;
    case "items-start":
    case "items-baseline":
      view.alignItems = "flex-start";
      return;
    case "items-end":
      view.alignItems = "flex-end";
      return;
    case "items-stretch":
      view.alignItems = "stretch";
      return;
    case "justify-center":
      view.justifyContent = "center";
      return;
    case "justify-between":
    case "justify-around":
    case "justify-evenly":
      view.justifyContent = "space-between";
      return;
    case "justify-start":
    case "justify-normal":
      view.justifyContent = "flex-start";
      return;
    case "justify-end":
      view.justifyContent = "flex-end";
      return;
    case "place-items-center":
    case "place-content-center":
      view.alignItems = "center";
      view.justifyContent = "center";
      if (token === "place-items-center") view.justifyItems = "center";
      return;
    case "self-start":
      view.alignSelf = "flex-start";
      return;
    case "self-center":
      view.alignSelf = "center";
      return;
    case "place-self-center":
      view.alignSelf = "center";
      view.justifySelf = "center";
      return;
    case "self-end":
      view.alignSelf = "flex-end";
      return;
    case "self-stretch":
      view.alignSelf = "stretch";
      return;
    // Fit-content width; the box applies it only inside a column parent.
    case "w-fit":
    case "w-max":
    case "w-min":
      acc.fitWidth = true;
      delete view.width;
      return;
    case "overflow-hidden":
    case "overflow-clip":
      view.overflow = "hidden";
      return;
    case "overflow-auto":
    case "overflow-y-auto":
    case "overflow-scroll":
    case "overflow-y-scroll":
      view.overflow = view.overflow === "scroll-x" ? "scroll-both" : "scroll";
      return;
    case "overflow-x-auto":
    case "overflow-x-scroll":
      view.overflow = view.overflow === "scroll" ? "scroll-both" : "scroll-x";
      return;
    case "absolute":
    case "fixed":
      view.position = "absolute";
      return;
    case "relative":
    case "sticky":
      view.position = "relative";
      return;
    case "static":
      view.position = undefined;
      return;
    case "truncate":
    case "line-clamp-1":
      acc.truncate = true;
      return;
    case "font-mono":
      text.fontFamily = "monospace";
      input.fontFamily = "monospace";
      return;
    case "font-sans":
    case "font-serif":
      text.fontFamily = "default";
      return;
    case "italic":
      text.fontStyle = "italic";
      return;
    case "not-italic":
      text.fontStyle = "normal";
      return;
    case "underline":
      text.textDecorationLine = "underline";
      return;
    case "line-through":
      text.textDecorationLine = "line-through";
      return;
    case "no-underline":
      text.textDecorationLine = "none";
      return;
    case "uppercase":
    case "lowercase":
    case "capitalize":
      acc.textTransform = token;
      return;
    case "normal-case":
      acc.textTransform = undefined;
      return;
    case "text-left":
    case "text-start":
      text.textAlign = "left";
      return;
    case "text-center":
      text.textAlign = "center";
      return;
    case "text-right":
    case "text-end":
      text.textAlign = "right";
      return;
    case "list-disc":
      acc.listStyle = "disc";
      return;
    case "list-decimal":
      acc.listStyle = "decimal";
      return;
    case "list-none":
      acc.listStyle = undefined;
      return;
    case "object-cover":
      acc.objectFit = "cover";
      return;
    case "object-contain":
      acc.objectFit = "contain";
      return;
    case "aspect-square":
      view.aspectRatio = 1;
      return;
    case "aspect-video":
      view.aspectRatio = 16 / 9;
      return;
    case "pointer-events-none":
      acc.pointerEventsNone = true;
      return;
    case "group":
      acc.group = "";
      return;
    case "border":
      view.borderWidth = 1;
      view.borderColor = view.borderColor ?? theme.border;
      input.borderColor = input.borderColor ?? theme.border;
      return;
    case "border-0":
      view.borderWidth = 0;
      return;
    case "shadow-xs":
    case "shadow-sm":
    case "shadow-md":
    case "shadow-lg":
    case "shadow-xl":
    case "shadow-2xl":
      view.shadow =
        token === "shadow-2xl" ? "xl" : (token.slice(7) as "xs" | "sm" | "md" | "lg" | "xl");
      return;
    case "shadow":
      view.shadow = "sm";
      return;
    case "shadow-none":
      view.shadow = undefined;
      return;
    case "mx-auto":
      view.marginLeft = "auto";
      view.marginRight = "auto";
      return;
    case "ml-auto":
    case "ms-auto":
      view.marginLeft = "auto";
      return;
    case "mr-auto":
    case "me-auto":
      view.marginRight = "auto";
      return;
    case "mt-auto":
      view.marginTop = "auto";
      return;
    case "inset-0":
      view.position = "absolute";
      view.top = 0;
      view.left = 0;
      view.right = 0;
      view.bottom = 0;
      return;
  }

  let m: RegExpMatchArray | null = token.match(/^group\/([\w-]+)$/);
  if (m) {
    acc.group = m[1];
    return;
  }

  m = token.match(/^(gap-x|gap-y|gap)-(.+)$/);
  if (m) {
    const value = spacing(m[2] ?? "");
    if (value === undefined) return;
    if (m[1] === "gap-x") view.columnGap = value;
    else if (m[1] === "gap-y") view.rowGap = value;
    else view.gap = value;
    return;
  }
  m = token.match(/^space-([xy])-(.+)$/);
  if (m) {
    const value = spacing(m[2] ?? "");
    // `-space-x-2` overlaps siblings; gaps cannot be negative, so it is a no-op.
    if (value !== undefined && !negative) {
      if (m[1] === "x") acc.spaceX = value;
      else acc.spaceY = value;
    }
    return;
  }
  m = token.match(/^p([xytblrse]?)-(.+)$/);
  if (m) {
    const value = spacing(m[2] ?? "");
    if (value === undefined) return;
    const axis = m[1] ?? "";
    // Later classes win: a broader padding clears earlier narrower ones
    // (`px-4 py-2 p-0` is zero), since the renderer prefers the narrow keys.
    if (axis === "") {
      for (const key of ["paddingHorizontal", "paddingVertical", ...Object.values(PADDING_KEYS)])
        delete view[key as keyof ViewStyle];
      view.padding = value;
      input.padding = value;
      return;
    }
    if (axis === "x") {
      delete view.paddingLeft;
      delete view.paddingRight;
      view.paddingHorizontal = value;
      return;
    }
    if (axis === "y") {
      delete view.paddingTop;
      delete view.paddingBottom;
      view.paddingVertical = value;
      return;
    }
    for (const side of sidesOf(axis)) set(view, PADDING_KEYS[side], value);
    return;
  }
  m = token.match(/^m([xytblrse]?)-(.+)$/);
  if (m) {
    const value = spacing(m[2] ?? "");
    if (value === undefined) return;
    for (const side of sidesOf(m[1] ?? "")) {
      const key = `margin${side[0]?.toUpperCase()}${side.slice(1)}` as
        | "marginTop"
        | "marginBottom"
        | "marginLeft"
        | "marginRight";
      view[key] = sign * value;
    }
    return;
  }
  m = token.match(/^(w|h|size|min-w|min-h|max-w|max-h|basis)-(.+)$/);
  if (m) {
    const kind = m[1];
    // A later width utility overrides an earlier `w-fit`, as in CSS.
    if (kind === "w" || kind === "size") acc.fitWidth = false;
    if (m[2] === "auto" && (kind === "w" || kind === "h" || kind === "size")) {
      // `h-auto` after `h-9` sizes to content again.
      if (kind !== "h") delete view.width;
      if (kind !== "w") delete view.height;
      return;
    }
    const value = length(m[2] ?? "");
    if (value === undefined) return;
    const px = typeof value === "number" ? value : undefined;
    switch (kind) {
      case "w":
        view.width = value;
        if (px !== undefined) input.width = px;
        // CSS `w-full` is width 100%; growth would stretch a textarea's height in a column.
        if (value === "100%") input.width = "100%";
        return;
      case "h":
        view.height = value;
        if (px !== undefined) input.height = px;
        return;
      case "size":
        view.width = value;
        view.height = value;
        return;
      case "min-w":
        if (px !== undefined) view.minWidth = px;
        return;
      case "min-h":
        if (px !== undefined) {
          view.minHeight = px;
          input.minHeight = px;
        }
        return;
      case "max-w":
        if (px !== undefined) view.maxWidth = px;
        return;
      case "max-h":
        if (px !== undefined) view.maxHeight = px;
        return;
      case "basis":
        view.width = value;
        view.flexShrink = 0;
        return;
    }
    return;
  }
  m = token.match(/^(top|left|right|bottom|inset-x|inset-y)-(.+)$/);
  if (m) {
    const value = spacing(m[2] ?? "");
    if (value === undefined) return;
    const signed = sign * value;
    if (m[1] === "inset-x") {
      view.left = signed;
      view.right = signed;
    } else if (m[1] === "inset-y") {
      view.top = signed;
      view.bottom = signed;
    } else {
      view[m[1] as "top" | "left" | "right" | "bottom"] = signed;
    }
    return;
  }
  if (applyGridUtility(token, view)) return;
  m = token.match(/^aspect-\[(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\]$/);
  if (m) {
    view.aspectRatio = Number(m[1]) / Number(m[2]);
    return;
  }
  m = token.match(/^rounded(?:-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?(?:-(.+))?$/);
  if (m) {
    const value = radius(m[1] ?? "", radiusBase);
    if (value !== undefined) {
      view.borderRadius = value;
      input.borderRadius = value;
    }
    return;
  }
  m = token.match(/^border-([xytblrse])(?:-(\d+))?$/);
  if (m) {
    const width = m[2] === undefined ? 1 : Number(m[2]);
    for (const side of sidesOf(m[1] ?? "")) set(view, BORDER_KEYS[side], width);
    view.borderColor = view.borderColor ?? theme.border;
    return;
  }
  m = token.match(/^border-(\d+)$/);
  if (m) {
    view.borderWidth = Number(m[1]);
    view.borderColor = view.borderColor ?? theme.border;
    return;
  }
  m = token.match(/^border-(?:[xytblrse]-)?(.+)$/);
  if (m) {
    if (["solid", "dashed", "dotted", "none", "double"].includes(m[1] ?? "")) return;
    const resolved = color(m[1] ?? "", theme);
    if (resolved) {
      view.borderColor = resolved;
      input.borderColor = resolved;
    }
    return;
  }
  m = token.match(/^bg-(.+)$/);
  if (m) {
    const resolved = color(m[1] ?? "", theme);
    if (resolved) {
      view.backgroundColor = resolved;
      input.backgroundColor = resolved;
    }
    return;
  }
  m = token.match(/^text-(xs|sm|base|lg|xl|[2-7]xl)(?:\/(.+))?$/);
  if (m) {
    const size = TEXT_SIZES[m[1] ?? ""];
    if (size) {
      text.fontSize = size[0];
      input.fontSize = size[0];
      if (m[2]) {
        const line = spacing(m[2]);
        if (line !== undefined) text.lineHeight = line;
      }
    }
    return;
  }
  m = token.match(/^text-\[(\d+(?:\.\d+)?)(px|rem)\]$/);
  if (m) {
    const size = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    text.fontSize = size;
    input.fontSize = size;
    return;
  }
  m = token.match(/^text-(.+)$/);
  if (m) {
    const resolved = color(m[1] ?? "", theme);
    if (resolved) {
      text.color = resolved;
      input.color = resolved;
    }
    return;
  }
  m = token.match(/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/);
  if (m) {
    const weight = m[1] ?? "normal";
    text.fontWeight =
      weight === "medium"
        ? "medium"
        : weight === "semibold"
          ? "semibold"
          : weight === "bold" || weight === "extrabold" || weight === "black"
            ? "bold"
            : "normal";
    return;
  }
  m = token.match(/^leading-(.+)$/);
  if (m) {
    const keyword = LEADING[m[1] ?? ""];
    if (keyword !== undefined) acc.leading = keyword;
    else {
      const px = spacing(m[1] ?? "");
      if (px !== undefined) text.lineHeight = px;
    }
    return;
  }
  m = token.match(/^opacity-(\d+)$/);
  if (m) {
    const value = Number(m[1]) / 100;
    view.opacity = value;
    text.opacity = value;
    return;
  }
  m = token.match(/^line-clamp-(\d+)$/);
  if (m) {
    if (m[1] === "1") acc.truncate = true;
  }
}
