/** Helpers shared by the Radix-compatible primitives. */

import type { Bounds } from "@mirinjs/metal";
import { useState } from "react";
import type { SyntheticEvent } from "../runtime/events.ts";

/** Classes Radix content uses to place itself; Metal places it instead. */
const PLACEMENT =
  /^(?:[\w-]+:)*-?(fixed|absolute|relative|top-|left-|right-|bottom-|inset-|translate-|z-|origin-|max-w-\[calc)/;

/** Drop placement utilities from a className, keeping everything visual. */
export function stripPlacement(className: string | undefined): string {
  return (className ?? "")
    .split(/\s+/)
    .filter((token) => token && !PLACEMENT.test(token))
    .join(" ");
}

/** The clicked element's rect from a DOM-shaped event. */
export function boundsOf(event: SyntheticEvent | undefined): Bounds | null {
  if (!event) return null;
  const rect = event.target.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Anchor rect state for popups opened from a trigger. */
export function useAnchor(): [Bounds | null, (next: Bounds | null) => void] {
  return useState<Bounds | null>(null);
}

export type Side = "top" | "right" | "bottom" | "left";
export type Align = "start" | "center" | "end";

export function dataState(open: boolean): "open" | "closed" {
  return open ? "open" : "closed";
}
