/**
 * One committed host node → its node in the JSON element tree the native
 * renderer understands (crates/mirin-metal `tree.rs`), without its children:
 * the "head" a whole tree is assembled from and a patch sets
 * (`lib/tree-sync.ts`). Events come back keyed by the ids stamped here.
 */

import type {
  AccessibilityProps,
  Color,
  Dimension,
  GridPlacement,
  GridTrack,
  LineNumbers,
  TextHighlight,
  TextInputStyle,
  TextRun,
  TextStyle,
  ViewStyle,
} from "../types.ts";
import type {
  HostInstance,
  HostNode,
  ImageInstance,
  InputInstance,
  RawTextInstance,
  SvgInstance,
  TextInstance,
  ViewInstance,
} from "./instances.ts";

interface ViewNodeProps {
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
  align?: "start" | "center" | "end" | "stretch";
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
  alignSelf?: "start" | "center" | "end" | "stretch";
  grid?: boolean;
  gridColumns?: GridTrack[];
  gridRows?: GridTrack[];
  justifyItems?: "start" | "center" | "end" | "stretch";
  justifySelf?: "start" | "center" | "end" | "stretch";
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

interface TextNodeProps {
  /** Only to address the node in a patch; sent to a patching host only. */
  id?: string;
  color?: Color;
  size?: number;
  weight?: "normal" | "medium" | "semibold" | "bold";
  mono?: boolean;
  truncate?: boolean;
  opacity?: number;
  align?: "left" | "center" | "right";
  italic?: boolean;
  underline?: boolean;
  lineThrough?: boolean;
  lineHeight?: number;
}

/** `access` on a view or an input: what the accessibility tree says of it (crates/mirin-metal/src/tree.rs `AccessProps`). */
interface AccessNodeProps {
  role?: string;
  label?: string;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  live?: "polite" | "assertive";
}

/** The accessibility props as the host takes them; undefined when there are none. */
function accessOf(props: AccessibilityProps): AccessNodeProps | undefined {
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

interface InputNodeProps {
  id: string;
  value: string;
  align?: "right";
  placeholder?: string;
  multiline?: boolean;
  secure?: boolean;
  mono?: boolean;
  size?: number;
  color?: Color;
  placeholderColor?: Color;
  background?: Color;
  padding?: number;
  cornerRadius?: number;
  borderColor?: Color;
  focusBorderColor?: Color;
  width?: number;
  widthPercent?: number;
  height?: number;
  minHeight?: number;
  flex?: number;
  autofocus?: boolean;
  revision?: number;
  onChange?: boolean;
  onSubmit?: boolean;
  focusNextOnSubmit?: boolean;
  submitOnEnter?: boolean;
  onKey?: boolean;
  selection?: { start: number; end: number };
  onSelection?: boolean;
  selectionColor?: Color;
  runs?: InputRunProps[];
  highlights?: TextHighlight[];
  lineNumbers?: LineNumbers;
  access?: AccessNodeProps;
}

interface ViewNode {
  type: "view";
  props: ViewNodeProps;
}

interface TextNode {
  type: "text";
  props: TextNodeProps;
  children: string[];
}

interface InputNode {
  type: "input";
  props: InputNodeProps;
}

interface SvgNode {
  type: "svg";
  props: {
    id?: string;
    markup: string;
    size?: number;
    width?: number;
    height?: number;
    color?: Color;
    opacity?: number;
  };
}

interface ImageNode {
  type: "image";
  props: {
    id?: string;
    src: string;
    width?: number;
    height?: number;
    fill?: boolean;
    cornerRadius?: number;
    cover?: boolean;
    opacity?: number;
  };
}

type TreeNode = ViewNode | TextNode | InputNode | SvgNode | ImageNode;

const ALIGN: Record<NonNullable<ViewStyle["alignItems"]>, ViewNodeProps["align"]> = {
  "flex-start": "start",
  center: "center",
  "flex-end": "end",
  stretch: "stretch",
};

const JUSTIFY: Record<NonNullable<ViewStyle["justifyContent"]>, ViewNodeProps["justify"]> = {
  "flex-start": "start",
  center: "center",
  "flex-end": "end",
  "space-between": "between",
};

const WEIGHT: Record<NonNullable<TextStyle["fontWeight"]>, TextNodeProps["weight"]> = {
  normal: "normal",
  "500": "medium",
  "600": "semibold",
  "700": "bold",
  medium: "medium",
  semibold: "semibold",
  bold: "bold",
};

/** How heads are written: with an `id` on every node (a patching host), and as the root (which always fills the window). */
export interface HeadOptions {
  ids: boolean;
  root: boolean;
}

/**
 * The node's JSON without its children: a view's `{"type":"view","props":…}`
 * (its children are other nodes), every other node whole. A string placed
 * directly in a view is a text node in the view's `textStyle`.
 */
export function headJson(
  node: HostNode,
  parent: HostInstance | null,
  options: HeadOptions,
): string {
  return JSON.stringify(head(node, parent, options));
}

function head(node: HostNode, parent: HostInstance | null, options: HeadOptions): TreeNode {
  const id = options.ids ? node.key : undefined;
  switch (node.kind) {
    case "raw": {
      const style = parent?.kind === "view" ? (parent.props.textStyle ?? {}) : {};
      return textNode(style, undefined, [node.text], id);
    }
    case "view": {
      const props = viewProps(node);
      // The root has no flex parent to grow into; it always fills the window.
      if (options.root) props.fill = true;
      return { type: "view", props } as ViewNode;
    }
    case "text":
      return serializeText(node, id);
    case "input":
      return { type: "input", props: inputProps(node) };
    case "svg":
      return serializeSvg(node, id);
    case "image":
      return serializeImage(node, id);
  }
}

function serializeSvg(instance: SvgInstance, id: string | undefined): SvgNode {
  const { markup, size, width, height, color, opacity } = instance.props;
  const props: SvgNode["props"] = id === undefined ? { markup } : { id, markup };
  if (size !== undefined) props.size = size;
  if (width !== undefined) props.width = width;
  if (height !== undefined) props.height = height;
  if (color) props.color = color;
  if (opacity !== undefined) props.opacity = opacity;
  return { type: "svg", props };
}

function serializeImage(instance: ImageInstance, id: string | undefined): ImageNode {
  const { source, resizeMode, style = {} } = instance.props;
  const props: ImageNode["props"] = id === undefined ? { src: source } : { id, src: source };
  if (style.width !== undefined) props.width = style.width;
  if (style.height !== undefined) props.height = style.height;
  if ((style.flex ?? 0) >= 1) props.fill = true;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (resizeMode === "cover") props.cover = true;
  return { type: "image", props };
}

/** Split a `Dimension` into the protocol's pixel or fraction field. */
/** Grid lines are 1-based and may count from the end; spans are at least 1. */
function placeInGrid(
  props: ViewNodeProps,
  placement: GridPlacement | undefined,
  axis: "col" | "row",
): void {
  if (!placement) return;
  const line = (value: number | undefined) =>
    value !== undefined && Number.isInteger(value) && value !== 0 ? value : undefined;
  const start = line(placement.start);
  const end = line(placement.end);
  const span =
    placement.span !== undefined && Number.isInteger(placement.span) && placement.span > 0
      ? placement.span
      : undefined;
  if (start !== undefined) props[`${axis}Start`] = start;
  if (end !== undefined) props[`${axis}End`] = end;
  if (span !== undefined) props[`${axis}Span`] = span;
}

function dimension(value: Dimension | undefined): { px?: number; fraction?: number } {
  if (value === undefined) return {};
  if (typeof value === "number") return { px: value };
  const percent = Number.parseFloat(value);
  return Number.isFinite(percent) ? { fraction: percent / 100 } : {};
}

function viewProps(instance: ViewInstance): ViewNodeProps {
  const style = instance.props.style ?? {};
  const props: ViewNodeProps = { id: instance.key };
  if (style.flexDirection) props.direction = style.flexDirection;
  if (style.gap !== undefined) props.gap = style.gap;
  if (style.padding !== undefined) props.padding = style.padding;
  if (style.paddingHorizontal !== undefined) props.paddingX = style.paddingHorizontal;
  if (style.paddingVertical !== undefined) props.paddingY = style.paddingVertical;
  if (style.paddingTop !== undefined) props.paddingTop = style.paddingTop;
  if (style.paddingBottom !== undefined) props.paddingBottom = style.paddingBottom;
  if (style.paddingLeft !== undefined) props.paddingLeft = style.paddingLeft;
  if (style.paddingRight !== undefined) props.paddingRight = style.paddingRight;
  if (style.marginTop === "auto") props.marginTopAuto = true;
  else if (style.marginTop !== undefined) props.marginTop = style.marginTop;
  if (style.marginBottom !== undefined) props.marginBottom = style.marginBottom;
  if (style.marginLeft === "auto") props.marginLeftAuto = true;
  else if (style.marginLeft !== undefined) props.marginLeft = style.marginLeft;
  if (style.marginRight === "auto") props.marginRightAuto = true;
  else if (style.marginRight !== undefined) props.marginRight = style.marginRight;
  if (style.borderTopWidth !== undefined) props.borderTop = style.borderTopWidth;
  if (style.borderBottomWidth !== undefined) props.borderBottom = style.borderBottomWidth;
  if (style.borderLeftWidth !== undefined) props.borderLeft = style.borderLeftWidth;
  if (style.borderRightWidth !== undefined) props.borderRight = style.borderRightWidth;
  if (style.shadow) props.shadow = style.shadow;
  const width = dimension(style.width);
  if (width.px !== undefined) props.width = width.px;
  if (width.fraction !== undefined) props.widthPercent = width.fraction;
  const height = dimension(style.height);
  if (height.px !== undefined) props.height = height.px;
  if (height.fraction !== undefined) props.heightPercent = height.fraction;
  if (style.aspectRatio !== undefined) props.aspectRatio = style.aspectRatio;
  if (style.flexWrap === "wrap") props.wrap = true;
  if (style.minWidth !== undefined) props.minWidth = style.minWidth;
  if (style.minHeight !== undefined) props.minHeight = style.minHeight;
  if (style.maxWidth !== undefined) props.maxWidth = style.maxWidth;
  if (style.maxHeight !== undefined) props.maxHeight = style.maxHeight;
  if (style.heightTransitionMs !== undefined) props.heightTransitionMs = style.heightTransitionMs;
  if (style.position === "absolute") props.absolute = true;
  if (style.position === "relative") props.relative = true;
  if (style.top !== undefined) props.top = style.top;
  if (style.left !== undefined) props.left = style.left;
  if (style.right !== undefined) props.right = style.right;
  if (style.bottom !== undefined) props.bottom = style.bottom;
  if (style.flex !== undefined) props.flex = style.flex;
  if (style.flexGrow !== undefined) props.grow = style.flexGrow;
  if (style.flexShrink === 0) props.shrink = false;
  // Said outright, so a scroll view's child that asks to shrink still does (it keeps its length by default).
  else if (typeof style.flexShrink === "number" && style.flexShrink > 0) props.shrink = true;
  if (style.alignItems === "center" && style.justifyContent === "center") {
    props.center = true;
  } else {
    if (style.alignItems) props.align = ALIGN[style.alignItems];
    if (style.justifyContent) props.justify = JUSTIFY[style.justifyContent];
  }
  if (style.backgroundColor) props.background = style.backgroundColor;
  if (style.hoverBackgroundColor) props.hoverBackground = style.hoverBackgroundColor;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;
  if (style.borderWidth !== undefined) props.borderWidth = style.borderWidth;
  if (style.borderColor) props.borderColor = style.borderColor;
  if (style.overflow === "scroll" || style.overflow === "scroll-both") props.scroll = true;
  if (style.overflow === "scroll-x" || style.overflow === "scroll-both") props.scrollX = true;
  if (style.overflow === "hidden") props.clip = true;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (style.focusRingColor) props.focusRingColor = style.focusRingColor;

  const {
    onPress,
    onHoverChange,
    onPointer,
    onContextMenu,
    onKeyDown,
    onWheel,
    dragFiles,
    onDrop,
    onLayout,
    occlude,
    dragRegion,
    focusable,
    focusGroup,
    selectsOnFocus,
    focusTrap,
    onWindowKeyDown,
  } = instance.props;
  if (focusable) props.focusable = true;
  if (focusGroup) props.focusGroup = true;
  if (focusGroup && selectsOnFocus) props.selectsOnFocus = true;
  if (focusTrap) props.focusTrap = true;
  if (onWindowKeyDown) {
    props.onWindowKey = true;
  }
  if (onLayout) {
    props.onLayout = true;
  }
  if (occlude) props.occlude = true;
  if (dragRegion) props.dragRegion = true;
  if (style.alignSelf) props.alignSelf = ALIGN[style.alignSelf];
  if (style.display === "grid") {
    props.grid = true;
    if (style.gridTemplateColumns) props.gridColumns = style.gridTemplateColumns;
    if (style.gridTemplateRows) props.gridRows = style.gridTemplateRows;
  }
  if (style.justifyItems) props.justifyItems = ALIGN[style.justifyItems];
  if (style.justifySelf) props.justifySelf = ALIGN[style.justifySelf];
  placeInGrid(props, style.gridColumn, "col");
  placeInGrid(props, style.gridRow, "row");
  if (style.columnGap !== undefined) props.gapX = style.columnGap;
  if (style.rowGap !== undefined) props.gapY = style.rowGap;
  if (onPointer) {
    props.onPointer = true;
  }
  if (onContextMenu) {
    props.onContextMenu = true;
  }
  if (onKeyDown) {
    props.onKeyDown = true;
  }
  if (onWheel) {
    props.onWheel = true;
  }
  if (dragFiles && dragFiles.paths.length > 0) {
    props.dragFiles = {
      paths: [...dragFiles.paths],
      ...(dragFiles.icon !== undefined ? { icon: dragFiles.icon } : {}),
      ...(dragFiles.iconSize !== undefined ? { iconSize: Math.round(dragFiles.iconSize) } : {}),
    };
  }
  if (onDrop) {
    props.onDrop = true;
  }
  if (onPress) {
    props.onPress = true;
  }
  if (onHoverChange) {
    props.onHover = true;
  }
  const access = accessOf(instance.props);
  if (access) props.access = access;

  return props;
}

function serializeText(instance: TextInstance, id: string | undefined): TextNode {
  const children = instance.children
    .filter((child): child is RawTextInstance => child.kind === "raw")
    .map((child) => child.text);
  return textNode(instance.props.style ?? {}, instance.props.numberOfLines, children, id);
}

function textNode(
  style: TextStyle,
  numberOfLines: number | undefined,
  children: string[],
  id: string | undefined,
): TextNode {
  const props: TextNodeProps = id === undefined ? {} : { id };
  if (style.color) props.color = style.color;
  if (style.fontSize !== undefined) props.size = style.fontSize;
  if (style.fontWeight && style.fontWeight !== "normal") props.weight = WEIGHT[style.fontWeight];
  if (style.fontFamily === "monospace") props.mono = true;
  if (numberOfLines === 1) props.truncate = true;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (style.textAlign && style.textAlign !== "left") props.align = style.textAlign;
  if (style.fontStyle === "italic") props.italic = true;
  if (style.textDecorationLine === "underline") props.underline = true;
  if (style.textDecorationLine === "line-through") props.lineThrough = true;
  if (style.lineHeight !== undefined) props.lineHeight = style.lineHeight;
  return { type: "text", props, children };
}

/** A styled run as the renderer takes it (`InputRun`). */
interface InputRunProps {
  start: number;
  end: number;
  color?: Color;
  background?: Color;
  weight?: "normal" | "medium" | "semibold" | "bold";
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  size?: number;
  press?: boolean;
}

function serializeRun(run: TextRun): InputRunProps {
  const start = offset(run.start);
  const props: InputRunProps = { start, end: Math.max(start, offset(run.end)) };
  if (run.color) props.color = run.color;
  if (run.backgroundColor) props.background = run.backgroundColor;
  if (run.fontWeight) props.weight = run.fontWeight;
  if (run.fontStyle === "italic") props.italic = true;
  if (run.textDecorationLine === "underline") props.underline = true;
  if (run.textDecorationLine === "line-through") props.strikethrough = true;
  if (run.fontSize !== undefined) props.size = run.fontSize;
  if (run.press) props.press = true;
  return props;
}

/** A selection offset as the renderer takes it: a whole number, at least 0. */
function offset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function inputProps(instance: InputInstance): InputNodeProps {
  const id = instance.key;
  const { props: input } = instance;
  const style: TextInputStyle = input.style ?? {};
  const props: InputNodeProps = { id, value: input.value };
  if (input.placeholder !== undefined) props.placeholder = input.placeholder;
  if (input.multiline) props.multiline = true;
  if (input.secureTextEntry) props.secure = true;
  if (input.autoFocus) props.autofocus = true;
  if (input.valueRevision !== undefined) props.revision = input.valueRevision;
  if (style.fontFamily === "monospace") props.mono = true;
  if (style.fontSize !== undefined) props.size = style.fontSize;
  if (style.color) props.color = style.color;
  if (style.placeholderColor) props.placeholderColor = style.placeholderColor;
  if (style.backgroundColor) props.background = style.backgroundColor;
  if (style.padding !== undefined) props.padding = style.padding;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;
  if (style.borderColor) props.borderColor = style.borderColor;
  if (style.focusBorderColor) props.focusBorderColor = style.focusBorderColor;
  if (style.width === "100%") props.widthPercent = 1;
  else if (style.width !== undefined) props.width = style.width;
  if (style.height !== undefined) props.height = style.height;
  if (style.minHeight !== undefined) props.minHeight = style.minHeight;
  if (style.flex !== undefined) props.flex = style.flex;
  if (style.textAlign === "right" && !input.multiline) props.align = "right";
  if (input.onChangeText) props.onChange = true;
  if (input.onSubmitEditing) props.onSubmit = true;
  if (input.focusNextOnSubmit) props.focusNextOnSubmit = true;
  if (input.multiline && input.submitBehavior === "submit") props.submitOnEnter = true;
  if (input.onKeyPress) props.onKey = true;
  if (input.selection)
    props.selection = { start: offset(input.selection.start), end: offset(input.selection.end) };
  if (input.onSelectionChange) props.onSelection = true;
  if (input.selectionColor) props.selectionColor = input.selectionColor;
  if (input.runs && input.runs.length > 0) props.runs = input.runs.map(serializeRun);
  if (input.highlights && input.highlights.length > 0)
    props.highlights = input.highlights.map(({ start, end, color }) => ({
      start: offset(start),
      end: offset(end),
      color,
    }));
  if (input.lineNumbers)
    props.lineNumbers = {
      width: Math.max(0, input.lineNumbers.width),
      color: input.lineNumbers.color,
    };
  const access = accessOf(input);
  if (access) props.access = access;
  return props;
}
