/**
 * A view's props as the host takes them (crates/mirin-metal `tree.rs`
 * `ViewProps`), worked out from what its style and props set: the style's
 * own keys are visited, not every field a view could have (a view sets a
 * handful of some seventy). The fields go out in one fixed order, the order
 * they always have, so a head written from the same props is the same text
 * (`lib/tree-sync.ts` compares heads as text) and the wire is unchanged.
 */

import type {
  AccessibilityProps,
  Color,
  Dimension,
  GridPlacement,
  GridTrack,
  ViewProps,
  ViewStyle,
} from "../types.ts";

export interface ViewNodeProps {
  id?: string;
  direction?: "row" | "column";
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  marginLeftAuto?: boolean;
  marginRightAuto?: boolean;
  marginTopAuto?: boolean;
  borderTop?: number;
  borderBottom?: number;
  borderLeft?: number;
  borderRight?: number;
  shadow?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  heightTransitionMs?: number;
  widthPercent?: number;
  heightPercent?: number;
  aspectRatio?: number;
  wrap?: boolean;
  absolute?: boolean;
  relative?: boolean;
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  flex?: number;
  grow?: number;
  shrink?: boolean;
  fill?: boolean;
  center?: boolean;
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  background?: Color;
  hoverBackground?: Color;
  cornerRadius?: number;
  borderWidth?: number;
  borderColor?: Color;
  scroll?: boolean;
  scrollX?: boolean;
  clip?: boolean;
  opacity?: number;
  onPress?: boolean;
  onHover?: boolean;
  onPointer?: boolean;
  onContextMenu?: boolean;
  onKeyDown?: boolean;
  onWheel?: boolean;
  dragFiles?: { paths: string[]; icon?: string; iconSize?: number };
  onDrop?: boolean;
  occlude?: boolean;
  dragRegion?: boolean;
  onLayout?: boolean;
  alignSelf?: "start" | "center" | "end" | "stretch" | "baseline";
  grid?: boolean;
  gridColumns?: GridTrack[];
  gridRows?: GridTrack[];
  justifyItems?: ViewNodeProps["align"];
  justifySelf?: ViewNodeProps["align"];
  colStart?: number;
  colEnd?: number;
  colSpan?: number;
  rowStart?: number;
  rowEnd?: number;
  rowSpan?: number;
  gapX?: number;
  gapY?: number;
  access?: AccessNodeProps;
  focusable?: boolean;
  focusGroup?: boolean;
  selectsOnFocus?: boolean;
  focusTrap?: boolean;
  focusRingColor?: Color;
  onWindowKey?: boolean;
}

/** `access` on a view or an input: what the accessibility tree says of it (crates/mirin-metal/src/tree.rs `AccessProps`). */
export interface AccessNodeProps {
  role?: string;
  label?: string;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  live?: "polite" | "assertive";
}

/** The accessibility props as the host takes them; undefined when there are none. */
export function accessOf(props: AccessibilityProps): AccessNodeProps | undefined {
  // Most nodes say nothing about accessibility: nothing to build for them.
  if (
    props.accessibilityRole === undefined &&
    props.accessibilityLabel === undefined &&
    props.accessibilityState === undefined &&
    props.accessibilityLiveRegion === undefined
  ) {
    return undefined;
  }
  const state = props.accessibilityState ?? {};
  const access: AccessNodeProps = {
    ...(props.accessibilityRole !== undefined ? { role: props.accessibilityRole } : {}),
    ...(props.accessibilityLabel !== undefined ? { label: props.accessibilityLabel } : {}),
    ...(state.selected !== undefined ? { selected: state.selected } : {}),
    ...(state.checked !== undefined ? { checked: state.checked } : {}),
    ...(state.expanded !== undefined ? { expanded: state.expanded } : {}),
    ...(state.disabled !== undefined ? { disabled: state.disabled } : {}),
    ...(props.accessibilityLiveRegion === "polite" || props.accessibilityLiveRegion === "assertive"
      ? { live: props.accessibilityLiveRegion }
      : {}),
  };
  return Object.keys(access).length > 0 ? access : undefined;
}

export const ALIGN: Record<NonNullable<ViewStyle["alignItems"]>, ViewNodeProps["align"]> = {
  "flex-start": "start",
  center: "center",
  "flex-end": "end",
  stretch: "stretch",
  baseline: "baseline",
};

const JUSTIFY: Record<NonNullable<ViewStyle["justifyContent"]>, ViewNodeProps["justify"]> = {
  "flex-start": "start",
  center: "center",
  "flex-end": "end",
  "space-between": "between",
};

/** Every field after `id`, in the order a head writes them. */
const ORDER = [
  "direction",
  "gap",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "marginTopAuto",
  "marginTop",
  "marginBottom",
  "marginLeftAuto",
  "marginLeft",
  "marginRightAuto",
  "marginRight",
  "borderTop",
  "borderBottom",
  "borderLeft",
  "borderRight",
  "shadow",
  "width",
  "widthPercent",
  "height",
  "heightPercent",
  "aspectRatio",
  "wrap",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "heightTransitionMs",
  "absolute",
  "relative",
  "top",
  "left",
  "right",
  "bottom",
  "flex",
  "grow",
  "shrink",
  "center",
  "align",
  "justify",
  "background",
  "hoverBackground",
  "cornerRadius",
  "borderWidth",
  "borderColor",
  "scroll",
  "scrollX",
  "clip",
  "opacity",
  "focusRingColor",
  "focusable",
  "focusGroup",
  "selectsOnFocus",
  "focusTrap",
  "onWindowKey",
  "onLayout",
  "occlude",
  "dragRegion",
  "alignSelf",
  "grid",
  "gridColumns",
  "gridRows",
  "justifyItems",
  "justifySelf",
  "colStart",
  "colEnd",
  "colSpan",
  "rowStart",
  "rowEnd",
  "rowSpan",
  "gapX",
  "gapY",
  "onPointer",
  "onContextMenu",
  "onKeyDown",
  "onWheel",
  "dragFiles",
  "onDrop",
  "onPress",
  "onHover",
  "access",
] as const satisfies ReadonlyArray<keyof ViewNodeProps>;

type Field = (typeof ORDER)[number];
const SLOT = Object.fromEntries(ORDER.map((field, slot) => [field, slot])) as Record<Field, number>;

/** `"field":`, by slot. */
const PREFIX = ORDER.map((field) => `"${field}":`);

/**
 * The fields one view sets, gathered by slot as JSON text and written out in
 * slot order. A head is worked out start to end without a call back into the
 * app, so one set of buffers serves every view.
 */
const values: unknown[] = new Array(ORDER.length).fill(undefined);
const taken = new Uint8Array(ORDER.length);
const slots: number[] = [];

function put(slot: number, value: unknown): void {
  if (taken[slot] === 0) {
    taken[slot] = 1;
    slots.push(slot);
  }
  values[slot] = value;
}

/** A value as `JSON.stringify` writes it; undefined for one it leaves out. */
function json(value: unknown): string | undefined {
  switch (typeof value) {
    case "number":
      // What JSON writes for a finite number is its string; NaN and the infinities are null.
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    default:
      return JSON.stringify(value);
  }
}

/** What was put, in slot order, after the id, as the props' JSON; the buffers are left empty. */
function written(id: string, root: boolean): string {
  // Insertion sort: a view sets a few fields.
  for (let index = 1; index < slots.length; index += 1) {
    const slot = slots[index] as number;
    let at = index - 1;
    while (at >= 0 && (slots[at] as number) > slot) {
      slots[at + 1] = slots[at] as number;
      at -= 1;
    }
    slots[at + 1] = slot;
  }
  // Ids are digits: nothing in them to escape.
  let text = `{"id":"${id}"`;
  for (const slot of slots) {
    const value = json(values[slot]);
    if (value !== undefined) text += `,${PREFIX[slot]}${value}`;
    values[slot] = undefined;
    taken[slot] = 0;
  }
  slots.length = 0;
  // The root has no flex parent to grow into; it always fills the window.
  return root ? `${text},"fill":true}` : `${text}}`;
}

/** Split a `Dimension` into the protocol's pixel or fraction field. */
function dimension(value: Dimension | undefined, px: Field, fraction: Field): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    put(SLOT[px], value);
    return;
  }
  const percent = Number.parseFloat(value);
  if (Number.isFinite(percent)) put(SLOT[fraction], percent / 100);
}

/** Grid lines are 1-based and may count from the end; spans are at least 1. */
function placeInGrid(placement: GridPlacement | undefined, axis: "col" | "row"): void {
  if (!placement) return;
  const line = (value: number | undefined) =>
    value !== undefined && Number.isInteger(value) && value !== 0 ? value : undefined;
  const start = line(placement.start);
  const end = line(placement.end);
  const span =
    placement.span !== undefined && Number.isInteger(placement.span) && placement.span > 0
      ? placement.span
      : undefined;
  if (start !== undefined) put(SLOT[`${axis}Start`], start);
  if (end !== undefined) put(SLOT[`${axis}End`], end);
  if (span !== undefined) put(SLOT[`${axis}Span`], span);
}

/** A field the style sets when its value is not undefined. */
function defined(slot: number, value: unknown): void {
  if (value !== undefined) put(slot, value);
}

/** A field the style sets when its value is truthy (a color, a name). */
function truthy(slot: number, value: unknown): void {
  if (value) put(slot, value);
}

/** A margin that may be `auto`. */
function margin(auto: number, slot: number, value: unknown): void {
  if (value === "auto") put(auto, true);
  else if (value !== undefined) put(slot, value);
}

// One `switch` over the keys a style has: a string switch is a jump on the
// key, where a lookup table per kind of field was a hash lookup each.
function styleProps(style: ViewStyle): void {
  // Read after the loop: each says something only with the other.
  let alignItems: ViewStyle["alignItems"];
  let justifyContent: ViewStyle["justifyContent"];
  let grid = false;
  for (const key in style) {
    const value: unknown = style[key as keyof ViewStyle];
    switch (key) {
      case "flexDirection":
        truthy(SLOT.direction, value);
        break;
      case "gap":
        defined(SLOT.gap, value);
        break;
      case "padding":
        defined(SLOT.padding, value);
        break;
      case "paddingHorizontal":
        defined(SLOT.paddingX, value);
        break;
      case "paddingVertical":
        defined(SLOT.paddingY, value);
        break;
      case "paddingTop":
        defined(SLOT.paddingTop, value);
        break;
      case "paddingBottom":
        defined(SLOT.paddingBottom, value);
        break;
      case "paddingLeft":
        defined(SLOT.paddingLeft, value);
        break;
      case "paddingRight":
        defined(SLOT.paddingRight, value);
        break;
      case "marginTop":
        margin(SLOT.marginTopAuto, SLOT.marginTop, value);
        break;
      case "marginBottom":
        defined(SLOT.marginBottom, value);
        break;
      case "marginLeft":
        margin(SLOT.marginLeftAuto, SLOT.marginLeft, value);
        break;
      case "marginRight":
        margin(SLOT.marginRightAuto, SLOT.marginRight, value);
        break;
      case "borderTopWidth":
        defined(SLOT.borderTop, value);
        break;
      case "borderBottomWidth":
        defined(SLOT.borderBottom, value);
        break;
      case "borderLeftWidth":
        defined(SLOT.borderLeft, value);
        break;
      case "borderRightWidth":
        defined(SLOT.borderRight, value);
        break;
      case "shadow":
        truthy(SLOT.shadow, value);
        break;
      case "width":
        dimension(style.width, "width", "widthPercent");
        break;
      case "height":
        dimension(style.height, "height", "heightPercent");
        break;
      case "aspectRatio":
        defined(SLOT.aspectRatio, value);
        break;
      case "flexWrap":
        if (value === "wrap") put(SLOT.wrap, true);
        break;
      case "minWidth":
        defined(SLOT.minWidth, value);
        break;
      case "minHeight":
        defined(SLOT.minHeight, value);
        break;
      case "maxWidth":
        defined(SLOT.maxWidth, value);
        break;
      case "maxHeight":
        defined(SLOT.maxHeight, value);
        break;
      case "heightTransitionMs":
        defined(SLOT.heightTransitionMs, value);
        break;
      case "position":
        if (value === "absolute") put(SLOT.absolute, true);
        if (value === "relative") put(SLOT.relative, true);
        break;
      case "top":
        defined(SLOT.top, value);
        break;
      case "left":
        defined(SLOT.left, value);
        break;
      case "right":
        defined(SLOT.right, value);
        break;
      case "bottom":
        defined(SLOT.bottom, value);
        break;
      case "flex":
        defined(SLOT.flex, value);
        break;
      case "flexGrow":
        defined(SLOT.grow, value);
        break;
      case "flexShrink":
        if (value === 0) put(SLOT.shrink, false);
        // Said outright, so a scroll view's child that asks to shrink still does (it keeps its length by default).
        else if (typeof value === "number" && value > 0) put(SLOT.shrink, true);
        break;
      case "alignItems":
        alignItems = style.alignItems;
        break;
      case "justifyContent":
        justifyContent = style.justifyContent;
        break;
      case "backgroundColor":
        truthy(SLOT.background, value);
        break;
      case "hoverBackgroundColor":
        truthy(SLOT.hoverBackground, value);
        break;
      case "borderRadius":
        defined(SLOT.cornerRadius, value);
        break;
      case "borderWidth":
        defined(SLOT.borderWidth, value);
        break;
      case "borderColor":
        truthy(SLOT.borderColor, value);
        break;
      case "overflow":
        if (value === "scroll" || value === "scroll-both") put(SLOT.scroll, true);
        if (value === "scroll-x" || value === "scroll-both") put(SLOT.scrollX, true);
        if (value === "hidden") put(SLOT.clip, true);
        break;
      case "opacity":
        defined(SLOT.opacity, value);
        break;
      case "focusRingColor":
        truthy(SLOT.focusRingColor, value);
        break;
      case "alignSelf":
        if (style.alignSelf) put(SLOT.alignSelf, ALIGN[style.alignSelf]);
        break;
      case "display":
        grid = value === "grid";
        if (grid) put(SLOT.grid, true);
        break;
      case "justifyItems":
        if (style.justifyItems) put(SLOT.justifyItems, ALIGN[style.justifyItems]);
        break;
      case "justifySelf":
        if (style.justifySelf) put(SLOT.justifySelf, ALIGN[style.justifySelf]);
        break;
      case "gridColumn":
        placeInGrid(style.gridColumn, "col");
        break;
      case "gridRow":
        placeInGrid(style.gridRow, "row");
        break;
      case "columnGap":
        defined(SLOT.gapX, value);
        break;
      case "rowGap":
        defined(SLOT.gapY, value);
        break;
    }
  }
  if (alignItems === "center" && justifyContent === "center") {
    put(SLOT.center, true);
  } else {
    if (alignItems) put(SLOT.align, ALIGN[alignItems]);
    if (justifyContent) put(SLOT.justify, JUSTIFY[justifyContent]);
  }
  if (grid) {
    if (style.gridTemplateColumns) put(SLOT.gridColumns, style.gridTemplateColumns);
    if (style.gridTemplateRows) put(SLOT.gridRows, style.gridTemplateRows);
  }
}

/**
 * A view's head, `{"type":"view","props":…}` without its children: its
 * style's fields, then what its other props say, in the order they have
 * always been written (`root`: it fills the window).
 */
export function viewHeadJson(id: string, props: ViewProps, root: boolean): string {
  if (props.style) styleProps(props.style);
  let accessible = false;
  for (const key in props) {
    switch (key) {
      // A handler is read when its event comes, never sent: the host is told there is one.
      case "focusable":
        truthy(SLOT.focusable, props.focusable && true);
        break;
      case "focusGroup":
        truthy(SLOT.focusGroup, props.focusGroup && true);
        break;
      case "selectsOnFocus":
        if (props.focusGroup && props.selectsOnFocus) put(SLOT.selectsOnFocus, true);
        break;
      case "focusTrap":
        truthy(SLOT.focusTrap, props.focusTrap && true);
        break;
      case "onWindowKeyDown":
        truthy(SLOT.onWindowKey, props.onWindowKeyDown && true);
        break;
      case "onLayout":
        truthy(SLOT.onLayout, props.onLayout && true);
        break;
      case "occlude":
        truthy(SLOT.occlude, props.occlude && true);
        break;
      case "dragRegion":
        truthy(SLOT.dragRegion, props.dragRegion && true);
        break;
      case "onPointer":
        truthy(SLOT.onPointer, props.onPointer && true);
        break;
      case "onContextMenu":
        truthy(SLOT.onContextMenu, props.onContextMenu && true);
        break;
      case "onKeyDown":
        truthy(SLOT.onKeyDown, props.onKeyDown && true);
        break;
      case "onWheel":
        truthy(SLOT.onWheel, props.onWheel && true);
        break;
      case "onDrop":
        truthy(SLOT.onDrop, props.onDrop && true);
        break;
      case "onPress":
        truthy(SLOT.onPress, props.onPress && true);
        break;
      case "onHoverChange":
        truthy(SLOT.onHover, props.onHoverChange && true);
        break;
      case "dragFiles": {
        const { dragFiles } = props;
        if (dragFiles && dragFiles.paths.length > 0) {
          put(SLOT.dragFiles, {
            paths: [...dragFiles.paths],
            ...(dragFiles.icon !== undefined ? { icon: dragFiles.icon } : {}),
            ...(dragFiles.iconSize !== undefined
              ? { iconSize: Math.round(dragFiles.iconSize) }
              : {}),
          });
        }
        break;
      }
      case "accessibilityRole":
      case "accessibilityLabel":
      case "accessibilityState":
      case "accessibilityLiveRegion":
        accessible = true;
        break;
    }
  }
  if (accessible) {
    const access = accessOf(props);
    if (access) put(SLOT.access, access);
  }
  return `{"type":"view","props":${written(id, root)}}`;
}
