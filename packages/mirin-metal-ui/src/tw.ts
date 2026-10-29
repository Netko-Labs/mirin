/**
 * Tailwind class strings → Metal styles. shadcn components (and the apps built
 * on them) express layout through utility classes; translating the common
 * subset lets that code run unchanged. Unknown classes are ignored, so
 * web-only utilities (`transition-*`, `focus-visible:*`, `sr-only`, …) are
 * harmless. Variant prefixes (`hover:`, `md:`, `dark:`, `data-[…]:`) are
 * skipped except `hover:bg-*`, which maps to `hoverBackgroundColor`.
 */

import type { TextInputStyle, TextStyle, ViewStyle } from "@mirinjs/metal";
import type { ThemeTokens } from "./theme.ts";

export interface TwStyle {
  view: ViewStyle;
  text: TextStyle;
  input: TextInputStyle;
}

/** Tailwind's spacing scale: `p-4` → 16px. Fractions like `p-1.5` work too. */
export function spacing(token: string): number | undefined {
  if (token === "px") return 1;
  if (token === "full") return undefined;
  const bracket = token.match(/^\[(\d+(?:\.\d+)?)px\]$/);
  if (bracket) return Number(bracket[1] ?? 0);
  const value = Number(token);
  return Number.isFinite(value) ? value * 4 : undefined;
}

const TEXT_SIZES: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
};

const RADII: Record<string, number> = {
  none: 0,
  sm: 4,
  "": 6,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  "3xl": 24,
  full: 999,
};

const WEIGHTS: Record<string, TextStyle["fontWeight"]> = {
  normal: "normal",
  medium: "medium",
  semibold: "semibold",
  bold: "bold",
};

const PALETTE: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "#00000000",
  "zinc-50": "#fafafa",
  "zinc-100": "#f4f4f5",
  "zinc-200": "#e4e4e7",
  "zinc-300": "#d4d4d8",
  "zinc-400": "#a1a1aa",
  "zinc-500": "#71717a",
  "zinc-600": "#52525b",
  "zinc-700": "#3f3f46",
  "zinc-800": "#27272a",
  "zinc-900": "#18181b",
  "zinc-950": "#09090b",
  "red-500": "#ef4444",
  "red-600": "#dc2626",
  "green-500": "#22c55e",
  "green-600": "#16a34a",
  "blue-500": "#3b82f6",
  "blue-600": "#2563eb",
  "yellow-500": "#eab308",
  "amber-500": "#f59e0b",
  "pink-500": "#ec4899",
  "purple-500": "#a855f7",
};

/** Map a Tailwind color token (`primary`, `muted-foreground`, `zinc-800`) to hex. */
export function color(token: string, theme: ThemeTokens): string | undefined {
  const [name = "", alpha] = token.split("/");
  const resolved = tokenColor(name, theme);
  if (!resolved) return undefined;
  if (alpha === undefined) return resolved;
  const percent = Number(alpha);
  if (!Number.isFinite(percent)) return resolved;
  const a = Math.round((percent / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${resolved.slice(0, 7)}${a}`;
}

function tokenColor(name: string, theme: ThemeTokens): string | undefined {
  const bracket = name.match(/^\[(#[0-9a-fA-F]{3,8})\]$/);
  if (bracket) return bracket[1];
  const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const themed = (theme as unknown as Record<string, string | undefined>)[camel];
  if (themed) return themed;
  return PALETTE[name];
}

/** Translate one class list. `cn()`-style arguments are flattened and deduped. */
export function tw(
  theme: ThemeTokens,
  ...classes: Array<string | false | null | undefined>
): TwStyle {
  const view: ViewStyle = {};
  const text: TextStyle = {};
  const input: TextInputStyle = {};
  const tokens = classes
    .filter((entry): entry is string => typeof entry === "string")
    .flatMap((entry) => entry.split(/\s+/))
    .filter((token) => token.length > 0);

  for (const raw of tokens) {
    let token = raw;
    let hover = false;
    const colon = token.lastIndexOf(":");
    if (colon >= 0) {
      const prefix = token.slice(0, colon);
      if (prefix === "hover") hover = true;
      else continue;
      token = token.slice(colon + 1);
    }
    const important = token.endsWith("!");
    if (important) token = token.slice(0, -1);
    apply(token, hover, theme, view, text, input);
  }
  return { view, text, input };
}

function apply(
  token: string,
  hover: boolean,
  theme: ThemeTokens,
  view: ViewStyle,
  text: TextStyle,
  input: TextInputStyle,
): void {
  if (hover) {
    const background = token.match(/^bg-(.+)$/);
    if (background) {
      const resolved = color(background[1] ?? "", theme);
      if (resolved) view.hoverBackgroundColor = resolved;
    }
    return;
  }

  switch (token) {
    case "flex":
      return;
    case "flex-row":
      view.flexDirection = "row";
      return;
    case "flex-col":
      view.flexDirection = "column";
      return;
    case "flex-1":
      view.flex = 1;
      return;
    case "flex-none":
    case "shrink-0":
      view.flexShrink = 0;
      return;
    case "grow":
      view.flex = 1;
      return;
    case "items-center":
      view.alignItems = "center";
      return;
    case "items-start":
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
      view.justifyContent = "space-between";
      return;
    case "justify-start":
      view.justifyContent = "flex-start";
      return;
    case "justify-end":
      view.justifyContent = "flex-end";
      return;
    case "w-full":
      view.flex = view.flex ?? 1;
      return;
    case "h-full":
    case "size-full":
      view.flex = view.flex ?? 1;
      return;
    case "overflow-hidden":
      view.overflow = "hidden";
      return;
    case "overflow-auto":
    case "overflow-y-auto":
    case "overflow-y-scroll":
      view.overflow = "scroll";
      return;
    case "overflow-x-auto":
    case "overflow-x-scroll":
      view.overflow = "scroll-x";
      return;
    case "absolute":
      view.position = "absolute";
      return;
    case "relative":
      view.position = "relative";
      return;
    case "truncate":
    case "whitespace-nowrap":
    case "text-ellipsis":
      return; // handled by <Text numberOfLines={1}> on the component side
    case "font-mono":
      text.fontFamily = "monospace";
      input.fontFamily = "monospace";
      return;
    case "text-center":
      text.textAlign = "center";
      return;
    case "text-right":
      text.textAlign = "right";
      return;
    case "text-left":
      text.textAlign = "left";
      return;
    case "border":
      view.borderWidth = 1;
      view.borderColor = view.borderColor ?? theme.border;
      input.borderColor = input.borderColor ?? theme.border;
      return;
    case "border-2":
      view.borderWidth = 2;
      view.borderColor = view.borderColor ?? theme.border;
      return;
    case "border-b":
    case "border-t":
    case "border-l":
    case "border-r":
    case "border-x":
    case "border-y":
      view.borderWidth = 1;
      view.borderColor = view.borderColor ?? theme.border;
      return;
    case "rounded":
      view.borderRadius = RADII[""];
      input.borderRadius = RADII[""];
      return;
    case "inset-0":
      view.position = "absolute";
      view.top = 0;
      view.left = 0;
      view.right = 0;
      view.bottom = 0;
      return;
  }

  const group = (pattern: RegExp): string[] | null => {
    const found = token.match(pattern);
    return found ? found.slice(1).map((part) => part ?? "") : null;
  };

  const gap = group(/^gap-(?:x-|y-)?(.+)$/);
  if (gap) {
    const value = spacing(gap[0] ?? "");
    if (value !== undefined) view.gap = value;
    return;
  }
  const pad = group(/^(p|px|py|pt|pb|pl|pr)-(.+)$/);
  if (pad) {
    const value = spacing(pad[1] ?? "");
    if (value === undefined) return;
    switch (pad[0]) {
      case "p":
        view.padding = value;
        input.padding = value;
        break;
      case "px":
      case "pl":
      case "pr":
        // Single-side padding is approximated by the matching axis.
        view.paddingHorizontal = value;
        break;
      default:
        view.paddingVertical = value;
    }
    return;
  }
  const size = group(/^(w|h|min-w|min-h|max-w|max-h|size)-(.+)$/);
  if (size) {
    const [axis, raw] = size;
    const value = spacing(raw ?? "");
    if (value === undefined) {
      if (raw === "full" && (axis === "w" || axis === "h" || axis === "size")) {
        view.flex = view.flex ?? 1;
      }
      return;
    }
    switch (axis) {
      case "w":
        view.width = value;
        input.width = value;
        break;
      case "h":
        view.height = value;
        input.height = value;
        break;
      case "size":
        view.width = value;
        view.height = value;
        break;
      case "min-w":
        view.minWidth = value;
        break;
      case "min-h":
        view.minHeight = value;
        input.minHeight = value;
        break;
      case "max-w":
        view.maxWidth = value;
        break;
      case "max-h":
        view.maxHeight = value;
        break;
    }
    return;
  }
  const offset = group(/^(top|left|right|bottom)-(.+)$/);
  if (offset) {
    const value = spacing(offset[1] ?? "");
    if (value === undefined) return;
    const side = offset[0];
    if (side === "top") view.top = value;
    else if (side === "left") view.left = value;
    else if (side === "right") view.right = value;
    else if (side === "bottom") view.bottom = value;
    return;
  }
  const rounded = group(/^rounded(?:-(?:t|b|l|r|tl|tr|bl|br))?(?:-(.+))?$/);
  if (rounded) {
    const radius = RADII[rounded[0] ?? ""];
    if (radius !== undefined) {
      view.borderRadius = radius;
      input.borderRadius = radius;
    }
    return;
  }
  const background = group(/^bg-(.+)$/);
  if (background) {
    const resolved = color(background[0] ?? "", theme);
    if (resolved) {
      view.backgroundColor = resolved;
      input.backgroundColor = resolved;
    }
    return;
  }
  const border = group(/^border-(.+)$/);
  if (border) {
    const resolved = color(border[0] ?? "", theme);
    if (resolved) {
      view.borderColor = resolved;
      input.borderColor = resolved;
      view.borderWidth = view.borderWidth ?? 1;
    }
    return;
  }
  const textSize = group(/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl)$/);
  if (textSize) {
    const value = TEXT_SIZES[textSize[0] ?? ""];
    if (value !== undefined) {
      text.fontSize = value;
      input.fontSize = value;
    }
    return;
  }
  const textPx = group(/^text-\[(\d+)px\]$/);
  if (textPx) {
    text.fontSize = Number(textPx[0]);
    input.fontSize = Number(textPx[0]);
    return;
  }
  const placeholder = group(/^placeholder:text-(.+)$/);
  if (placeholder) {
    const resolved = color(placeholder[0] ?? "", theme);
    if (resolved) input.placeholderColor = resolved;
    return;
  }
  const textColor = group(/^text-(.+)$/);
  if (textColor) {
    const resolved = color(textColor[0] ?? "", theme);
    if (resolved) {
      text.color = resolved;
      input.color = resolved;
    }
    return;
  }
  const weight = group(/^font-(normal|medium|semibold|bold)$/);
  if (weight) {
    text.fontWeight = WEIGHTS[weight[0] ?? ""];
    return;
  }
  const opacity = group(/^opacity-(\d+)$/);
  if (opacity) {
    view.opacity = Number(opacity[0]) / 100;
    text.opacity = Number(opacity[0]) / 100;
  }
}
