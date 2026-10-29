/**
 * Anchored popup placement (the floating-ui role in Radix): position content
 * next to an anchor rect on a side with an alignment, then measure the
 * content after its first paint and flip or shift it to stay in the window.
 */

import { type Bounds, View } from "@mirinjs/metal";
import { type ReactNode, useState } from "react";
import { useOverlay } from "./host.tsx";

export type Side = "top" | "right" | "bottom" | "left";
export type Align = "start" | "center" | "end";

export interface PopperProps {
  /** The trigger's painted rect, or a point (width/height 0) for context menus. */
  anchor: Bounds;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  /** Make the content at least as wide as the anchor (selects, comboboxes). */
  matchWidth?: boolean;
  children: ReactNode;
  testID?: string;
}

const MARGIN = 8;

function opposite(side: Side): Side {
  return side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
}

/** Top-left for content of `size` placed on `side` of `anchor`. */
export function place(
  anchor: Bounds,
  size: { width: number; height: number },
  side: Side,
  align: Align,
  sideOffset: number,
  alignOffset: number,
): { x: number; y: number } {
  const alongX = side === "top" || side === "bottom";
  const crossStart = alongX ? anchor.x : anchor.y;
  const crossLength = alongX ? anchor.width : anchor.height;
  const contentCross = alongX ? size.width : size.height;
  const cross =
    align === "start"
      ? crossStart + alignOffset
      : align === "end"
        ? crossStart + crossLength - contentCross - alignOffset
        : crossStart + (crossLength - contentCross) / 2;
  switch (side) {
    case "bottom":
      return { x: cross, y: anchor.y + anchor.height + sideOffset };
    case "top":
      return { x: cross, y: anchor.y - size.height - sideOffset };
    case "right":
      return { x: anchor.x + anchor.width + sideOffset, y: cross };
    case "left":
      return { x: anchor.x - size.width - sideOffset, y: cross };
  }
}

/** Flip to the opposite side if it overflows and the other side fits better, then shift into view. */
export function resolvePlacement(
  anchor: Bounds,
  size: { width: number; height: number },
  window: { width: number; height: number },
  side: Side,
  align: Align,
  sideOffset: number,
  alignOffset: number,
): { x: number; y: number; side: Side } {
  const fits = (pos: { x: number; y: number }) =>
    pos.y >= MARGIN &&
    pos.x >= MARGIN &&
    pos.y + size.height <= window.height - MARGIN &&
    pos.x + size.width <= window.width - MARGIN;
  let chosen = side;
  let pos = place(anchor, size, side, align, sideOffset, alignOffset);
  if (!fits(pos) && window.width > 0) {
    const flipped = place(anchor, size, opposite(side), align, sideOffset, alignOffset);
    if (fits(flipped)) {
      pos = flipped;
      chosen = opposite(side);
    }
  }
  if (window.width > 0) {
    pos.x = Math.max(MARGIN, Math.min(pos.x, window.width - size.width - MARGIN));
    pos.y = Math.max(MARGIN, Math.min(pos.y, window.height - size.height - MARGIN));
  }
  return { ...pos, side: chosen };
}

/** Absolutely positioned popup content. Render inside a `Portal`. */
export function Popper({
  anchor,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  matchWidth = false,
  children,
  testID,
}: PopperProps) {
  const { size: window } = useOverlay();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const measured = size ?? { width: 0, height: 0 };
  const pos = resolvePlacement(anchor, measured, window, side, align, sideOffset, alignOffset);
  return (
    <View
      occlude
      testID={testID}
      onLayout={(bounds) => {
        if (!size || size.width !== bounds.width || size.height !== bounds.height) {
          setSize({ width: bounds.width, height: bounds.height });
        }
      }}
      style={{
        position: "absolute",
        left: Math.round(pos.x),
        top: Math.round(pos.y),
        // Hidden until measured, so the first frame never shows a misplaced popup.
        opacity: size ? 1 : 0,
        ...(matchWidth ? { minWidth: anchor.width } : {}),
        flexDirection: "column",
      }}
    >
      {children}
    </View>
  );
}
