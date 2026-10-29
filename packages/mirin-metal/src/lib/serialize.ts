/**
 * Committed instance tree → the JSON element tree the native renderer
 * understands (crates/mirin-metal `tree.rs`), plus the handler maps keyed by
 * the node ids stamped into that tree.
 */

import type {
  Bounds,
  Color,
  Dimension,
  PointerInfo,
  TextInputStyle,
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
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
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
  occlude?: boolean;
  alignSelf?: "start" | "center" | "end" | "stretch";
}

interface TextNodeProps {
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

interface InputNodeProps {
  id: string;
  value: string;
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
  height?: number;
  minHeight?: number;
  flex?: number;
  autofocus?: boolean;
  onChange?: boolean;
  onSubmit?: boolean;
}

interface ViewNode {
  type: "view";
  props: ViewNodeProps;
  children: TreeNode[];
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

export interface Handlers {
  press: Map<string, (event: { bounds?: Bounds }) => void>;
  hover: Map<string, (hovered: boolean, bounds?: Bounds) => void>;
  pointer: Map<string, (event: PointerInfo) => void>;
  contextMenu: Map<string, (event: { x: number; y: number }) => void>;
  change: Map<string, (text: string) => void>;
  submit: Map<string, (text: string) => void>;
  /** `testID` → native node id, for checks and tools. */
  testIds: Map<string, string>;
}

export interface SerializedUi {
  treeJson: string;
  handlers: Handlers;
}

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

/** Serialize the committed root, or null when nothing is mounted. */
export function serializeRoot(children: HostNode[]): SerializedUi | null {
  const root = children.find((child): child is HostInstance => child.kind !== "raw");
  if (!root) {
    return null;
  }
  const handlers: Handlers = {
    press: new Map(),
    hover: new Map(),
    pointer: new Map(),
    contextMenu: new Map(),
    change: new Map(),
    submit: new Map(),
    testIds: new Map(),
  };
  const tree = serializeInstance(root, handlers);
  // The root has no flex parent to grow into; it always fills the window.
  if (tree.type === "view") tree.props.fill = true;
  return { treeJson: JSON.stringify(tree), handlers };
}

function serializeInstance(instance: HostInstance, handlers: Handlers): TreeNode {
  switch (instance.kind) {
    case "view":
      return serializeView(instance, handlers);
    case "text":
      return serializeText(instance);
    case "input":
      return serializeInput(instance, handlers);
    case "svg":
      return serializeSvg(instance);
    case "image":
      return serializeImage(instance);
  }
}

function serializeSvg(instance: SvgInstance): SvgNode {
  const { markup, size, width, height, color, opacity } = instance.props;
  const props: SvgNode["props"] = { markup };
  if (size !== undefined) props.size = size;
  if (width !== undefined) props.width = width;
  if (height !== undefined) props.height = height;
  if (color) props.color = color;
  if (opacity !== undefined) props.opacity = opacity;
  return { type: "svg", props };
}

function serializeImage(instance: ImageInstance): ImageNode {
  const { source, resizeMode, style = {} } = instance.props;
  const props: ImageNode["props"] = { src: source };
  if (style.width !== undefined) props.width = style.width;
  if (style.height !== undefined) props.height = style.height;
  if ((style.flex ?? 0) >= 1) props.fill = true;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (resizeMode === "cover") props.cover = true;
  return { type: "image", props };
}

/** Split a `Dimension` into the protocol's pixel or fraction field. */
function dimension(value: Dimension | undefined): { px?: number; fraction?: number } {
  if (value === undefined) return {};
  if (typeof value === "number") return { px: value };
  const percent = Number.parseFloat(value);
  return Number.isFinite(percent) ? { fraction: percent / 100 } : {};
}

function serializeView(instance: ViewInstance, handlers: Handlers): ViewNode {
  const style = instance.props.style ?? {};
  const props: ViewNodeProps = { id: String(instance.id) };
  if (style.flexDirection) props.direction = style.flexDirection;
  if (style.gap !== undefined) props.gap = style.gap;
  if (style.padding !== undefined) props.padding = style.padding;
  if (style.paddingHorizontal !== undefined) props.paddingX = style.paddingHorizontal;
  if (style.paddingVertical !== undefined) props.paddingY = style.paddingVertical;
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
  if (style.position === "absolute") props.absolute = true;
  if (style.position === "relative") props.relative = true;
  if (style.top !== undefined) props.top = style.top;
  if (style.left !== undefined) props.left = style.left;
  if (style.right !== undefined) props.right = style.right;
  if (style.bottom !== undefined) props.bottom = style.bottom;
  if (style.flex !== undefined) props.flex = style.flex;
  if (style.flexShrink === 0) props.shrink = false;
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

  const { onPress, onHoverChange, onPointer, onContextMenu, occlude, testID } = instance.props;
  if (occlude) props.occlude = true;
  if (style.alignSelf) props.alignSelf = ALIGN[style.alignSelf];
  if (onPointer) {
    props.onPointer = true;
    handlers.pointer.set(String(instance.id), onPointer);
  }
  if (onContextMenu) {
    props.onContextMenu = true;
    handlers.contextMenu.set(String(instance.id), onContextMenu);
  }
  if (onPress) {
    props.onPress = true;
    handlers.press.set(String(instance.id), onPress);
  }
  if (onHoverChange) {
    props.onHover = true;
    handlers.hover.set(String(instance.id), onHoverChange);
  }
  if (testID) handlers.testIds.set(testID, String(instance.id));

  const children = instance.children
    .filter((child): child is HostInstance => child.kind !== "raw")
    .map((child) => serializeInstance(child, handlers));
  return { type: "view", props, children };
}

function serializeText(instance: TextInstance): TextNode {
  const style = instance.props.style ?? {};
  const props: TextNodeProps = {};
  if (style.color) props.color = style.color;
  if (style.fontSize !== undefined) props.size = style.fontSize;
  if (style.fontWeight && style.fontWeight !== "normal") props.weight = WEIGHT[style.fontWeight];
  if (style.fontFamily === "monospace") props.mono = true;
  if (instance.props.numberOfLines === 1) props.truncate = true;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (style.textAlign && style.textAlign !== "left") props.align = style.textAlign;
  if (style.fontStyle === "italic") props.italic = true;
  if (style.textDecorationLine === "underline") props.underline = true;
  if (style.textDecorationLine === "line-through") props.lineThrough = true;
  if (style.lineHeight !== undefined) props.lineHeight = style.lineHeight;
  const children = instance.children
    .filter((child): child is RawTextInstance => child.kind === "raw")
    .map((child) => child.text);
  return { type: "text", props, children };
}

function serializeInput(instance: InputInstance, handlers: Handlers): InputNode {
  const id = String(instance.id);
  const { props: input } = instance;
  const style: TextInputStyle = input.style ?? {};
  const props: InputNodeProps = { id, value: input.value };
  if (input.placeholder !== undefined) props.placeholder = input.placeholder;
  if (input.multiline) props.multiline = true;
  if (input.secureTextEntry) props.secure = true;
  if (input.autoFocus) props.autofocus = true;
  if (style.fontFamily === "monospace") props.mono = true;
  if (style.fontSize !== undefined) props.size = style.fontSize;
  if (style.color) props.color = style.color;
  if (style.placeholderColor) props.placeholderColor = style.placeholderColor;
  if (style.backgroundColor) props.background = style.backgroundColor;
  if (style.padding !== undefined) props.padding = style.padding;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;
  if (style.borderColor) props.borderColor = style.borderColor;
  if (style.focusBorderColor) props.focusBorderColor = style.focusBorderColor;
  if (style.width !== undefined) props.width = style.width;
  if (style.height !== undefined) props.height = style.height;
  if (style.minHeight !== undefined) props.minHeight = style.minHeight;
  if (style.flex !== undefined) props.flex = style.flex;
  if (input.onChangeText) {
    props.onChange = true;
    handlers.change.set(id, input.onChangeText);
  }
  if (input.onSubmitEditing) {
    props.onSubmit = true;
    handlers.submit.set(id, input.onSubmitEditing);
  }
  if (input.testID) handlers.testIds.set(input.testID, id);
  return { type: "input", props };
}
