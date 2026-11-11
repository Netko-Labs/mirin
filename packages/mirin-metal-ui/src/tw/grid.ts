/**
 * Grid utilities: track lists (`grid-cols-3`, `grid-cols-[16px_1fr]`),
 * placement (`col-span-2`, `col-start-2`, `row-span-2`), and inline-axis
 * alignment (`justify-items-*`, `justify-self-*`, `place-*`). The renderer
 * lays grids out natively (taffy CSS grid), so these map one to one.
 */

import type { GridPlacement, GridTrack, ViewStyle } from "@mirinjs/metal";

type Align = NonNullable<ViewStyle["justifyItems"]>;

const ALIGN: Record<string, Align> = {
  start: "flex-start",
  end: "flex-end",
  center: "center",
  stretch: "stretch",
};

/** `repeat(N, minmax(0, 1fr))`: Tailwind's `grid-cols-N`. */
function equalTracks(count: number): GridTrack[] {
  return Array.from({ length: count }, () => ({ min: 0, max: "1fr" as const }));
}

/** Split on a separator outside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

type Breadth = Exclude<GridTrack, object>;

function breadth(text: string): Breadth | undefined {
  if (text === "auto" || text === "min-content" || text === "max-content") return text;
  const unit = text.match(/^(\d*\.?\d+)(px|rem|fr|%)?$/);
  if (!unit) return undefined;
  const value = Number(unit[1]);
  switch (unit[2]) {
    case "fr":
      return `${value}fr`;
    case "%":
      return `${value}%`;
    case "rem":
      return value * 16;
    default:
      return value;
  }
}

/** Parse one track: a breadth, `minmax(a,b)`, or `fit-content(…)` (as auto). */
function track(text: string): GridTrack | undefined {
  const minmax = text.match(/^minmax\((.*)\)$/);
  if (minmax) {
    const [min, max, ...rest] = splitTopLevel(minmax[1] ?? "", ",");
    const low = min === undefined ? undefined : breadth(min);
    const high = max === undefined ? undefined : breadth(max);
    if (rest.length > 0 || low === undefined || high === undefined) return undefined;
    if (typeof low === "string" && low.endsWith("fr")) return undefined;
    return { min: low as Exclude<Breadth, `${number}fr`>, max: high };
  }
  if (/^fit-content\(/.test(text)) return "auto";
  return breadth(text);
}

/** Parse an arbitrary track list (`16px_1fr`, `repeat(3,minmax(0,1fr))`). */
export function parseTracks(text: string): GridTrack[] | undefined {
  const tracks: GridTrack[] = [];
  for (const part of splitTopLevel(text.replace(/_/g, " "), " ")) {
    const repeat = part.match(/^repeat\((\d+),(.*)\)$/);
    if (repeat) {
      const inner = splitTopLevel(repeat[2] ?? "", " ").map(track);
      if (inner.some((item) => item === undefined)) return undefined;
      for (let index = 0; index < Number(repeat[1]); index += 1) {
        tracks.push(...(inner as GridTrack[]));
      }
      continue;
    }
    const parsed = track(part);
    if (parsed === undefined) return undefined;
    tracks.push(parsed);
  }
  return tracks.length > 0 ? tracks : undefined;
}

function place(view: ViewStyle, axis: "gridColumn" | "gridRow", patch: GridPlacement): void {
  view[axis] = { ...view[axis], ...patch };
}

/** Apply a grid utility to `view`. Returns false when `token` is not one. */
export function applyGridUtility(token: string, view: ViewStyle): boolean {
  let m = token.match(/^grid-(cols|rows)-(.+)$/);
  if (m) {
    const key = m[1] === "cols" ? "gridTemplateColumns" : "gridTemplateRows";
    const value = m[2] ?? "";
    if (value === "none" || value === "subgrid") {
      view[key] = undefined;
      return true;
    }
    if (/^\d+$/.test(value)) {
      view[key] = equalTracks(Number(value));
      return true;
    }
    const arbitrary = value.match(/^\[(.+)\]$/);
    const tracks = arbitrary ? parseTracks(arbitrary[1] ?? "") : undefined;
    if (tracks) view[key] = tracks;
    return true;
  }
  m = token.match(/^(col|row)-(span|start|end)-(.+)$/);
  if (m) {
    const axis = m[1] === "col" ? "gridColumn" : "gridRow";
    const value = m[3] ?? "";
    if (m[2] === "span") {
      if (value === "full") place(view, axis, { start: 1, end: -1, span: undefined });
      else if (/^\d+$/.test(value)) place(view, axis, { span: Number(value) });
      return true;
    }
    const line = value.match(/^(-?\d+)$/) ?? value.match(/^\[(-?\d+)\]$/);
    if (line) place(view, axis, { [m[2] === "start" ? "start" : "end"]: Number(line[1]) });
    return true;
  }
  m = token.match(/^(justify-items|justify-self|place-items|place-self)-(.+)$/);
  if (m) {
    const align = ALIGN[m[2] ?? ""];
    if (m[2] === "auto") return true;
    if (!align) return false;
    if (m[1] === "justify-items") view.justifyItems = align;
    else if (m[1] === "justify-self") view.justifySelf = align;
    else if (m[1] === "place-items") {
      view.alignItems = align;
      view.justifyItems = align;
    } else {
      view.alignSelf = align;
      view.justifySelf = align;
    }
    return true;
  }
  // Implicit track sizing (`auto-rows-min`) has no renderer equivalent yet;
  // implicit tracks stay `auto`.
  return /^(auto-rows|auto-cols|grid-flow)-/.test(token);
}
