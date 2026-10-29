/**
 * React DOM `style={{ … }}` objects → Metal styles, for the properties
 * examples set inline (sizes, colors, gaps). CSS custom properties and
 * unsupported properties are ignored.
 */

import type { TextStyle, ViewStyle } from "@mirinjs/metal";

type Css = Record<string, unknown>;

function px(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(px|rem)?$/);
  if (!match) return undefined;
  return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
}

function dimension(value: unknown): number | `${number}%` | undefined {
  if (typeof value === "string") {
    const percent = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (percent) return `${Number(percent[1])}%`;
  }
  return px(value);
}

function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : undefined;
}

export function cssToMetal(css: Css | undefined): { view: ViewStyle; text: TextStyle } {
  const view: ViewStyle = {};
  const text: TextStyle = {};
  if (!css) return { view, text };
  const width = dimension(css.width);
  if (width !== undefined) view.width = width;
  const height = dimension(css.height);
  if (height !== undefined) view.height = height;
  const minWidth = px(css.minWidth);
  if (minWidth !== undefined) view.minWidth = minWidth;
  const maxWidth = px(css.maxWidth);
  if (maxWidth !== undefined) view.maxWidth = maxWidth;
  const minHeight = px(css.minHeight);
  if (minHeight !== undefined) view.minHeight = minHeight;
  const maxHeight = px(css.maxHeight);
  if (maxHeight !== undefined) view.maxHeight = maxHeight;
  const gap = px(css.gap);
  if (gap !== undefined) view.gap = gap;
  const padding = px(css.padding);
  if (padding !== undefined) view.padding = padding;
  const radius = px(css.borderRadius);
  if (radius !== undefined) view.borderRadius = radius;
  const background = hexColor(css.backgroundColor ?? css.background);
  if (background) view.backgroundColor = background;
  const border = hexColor(css.borderColor);
  if (border) view.borderColor = border;
  if (typeof css.opacity === "number") {
    view.opacity = css.opacity;
    text.opacity = css.opacity;
  }
  if (typeof css.flex === "number") view.flex = css.flex;
  const color = hexColor(css.color);
  if (color) text.color = color;
  const fontSize = px(css.fontSize);
  if (fontSize !== undefined) text.fontSize = fontSize;
  return { view, text };
}
