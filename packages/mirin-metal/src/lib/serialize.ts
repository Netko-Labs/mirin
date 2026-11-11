/**
 * One committed host node → its node in the JSON element tree the native
 * renderer understands (crates/mirin-metal `tree.rs`), without its children:
 * the "head" a whole tree is assembled from and a patch sets
 * (`lib/tree-sync.ts`). Events come back keyed by the ids stamped here.
 */

import type {
  Color,
  LineNumbers,
  TextHighlight,
  TextInputStyle,
  TextRun,
  TextStyle,
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
import { ownText } from "./instances.ts";
import { type AccessNodeProps, accessOf, viewHeadJson } from "./view-props.ts";

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

/** Every node but a view, whose head `view-props.ts` writes as text. */
type TreeNode = TextNode | InputNode | SvgNode | ImageNode;

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
  // A view's head is written as text, from the fields it sets (`view-props.ts`).
  if (node.kind === "view") return viewHeadJson(node.key, node.props, options.root);
  return JSON.stringify(head(node, parent, options));
}

function head(
  node: Exclude<HostNode, ViewInstance>,
  parent: HostInstance | null,
  options: HeadOptions,
): TreeNode {
  const id = options.ids ? node.key : undefined;
  switch (node.kind) {
    case "raw": {
      const style = parent?.kind === "view" ? (parent.props.textStyle ?? {}) : {};
      return textNode(style, undefined, [node.text], id);
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

function serializeText(instance: TextInstance, id: string | undefined): TextNode {
  // One string is the text's own (`shouldSetTextContent`), several its nodes.
  const own = ownText(instance.props);
  const children =
    own !== null
      ? [own]
      : instance.children
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
