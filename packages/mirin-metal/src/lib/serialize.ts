/**
 * One committed host node → its node in the JSON element tree the native
 * renderer understands (crates/mirin-metal `tree.rs`), without its children:
 * the "head" a whole tree is assembled from and a patch sets
 * (`lib/tree-sync.ts`). Events come back keyed by the ids stamped here.
 */

import type {
  Color,
  FontWeightName,
  LineNumbers,
  TextHighlight,
  TextInputStyle,
  TextRun,
  TextStyle,
} from "../types.ts";
import type {
  DotsInstance,
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
  weight?: FontWeightName;
  mono?: boolean;
  display?: boolean;
  truncate?: boolean;
  opacity?: number;
  align?: "left" | "center" | "right";
  italic?: boolean;
  underline?: boolean;
  lineThrough?: boolean;
  lineHeight?: number;
  tabSize?: number;
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
  baseHash?: number;
  onChange?: boolean;
  onSubmit?: boolean;
  focusNextOnSubmit?: boolean;
  submitOnEnter?: boolean;
  insertTab?: boolean;
  shiftTabKey?: boolean;
  tabSize?: number;
  onKey?: boolean;
  selection?: { start: number; end: number; textHash?: number };
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
    onError?: boolean;
  };
}

interface DotsNode {
  type: "dots";
  props: {
    id?: string;
    count: number;
    rows?: number;
    pitch: number;
    radius: number;
    lit?: number;
    color?: Color;
    unlitColor?: Color;
    head?: number;
    headColor?: Color;
    headRing?: boolean;
    cells?: string;
    opacity?: number;
  };
}

/** Every node but a view, whose head `view-props.ts` writes as text. */
type TreeNode = TextNode | InputNode | SvgNode | ImageNode | DotsNode;

/** A weight as the host names it; `normal` (400) is left out of the node. */
const WEIGHT: Record<NonNullable<TextStyle["fontWeight"]>, FontWeightName | "normal"> = {
  normal: "normal",
  "100": "thin",
  "200": "extralight",
  "300": "light",
  "400": "normal",
  "500": "medium",
  "600": "semibold",
  "700": "bold",
  "800": "extrabold",
  "900": "black",
  thin: "thin",
  extralight: "extralight",
  light: "light",
  medium: "medium",
  semibold: "semibold",
  bold: "bold",
  extrabold: "extrabold",
  black: "black",
};

/**
 * How heads are written: with an `id` on every node (a patching host), as
 * the root (which always fills the window), with `onScroll` said (a host
 * that reports scroll offsets), and with an image's `onError` said (a host
 * that tells of images it cannot draw).
 */
export interface HeadOptions {
  ids: boolean;
  root: boolean;
  scrolls?: boolean;
  imageErrors?: boolean;
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
  if (node.kind === "view") {
    return viewHeadJson(node.key, node.props, options.root, options.scrolls);
  }
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
      return serializeImage(node, id, options.imageErrors === true);
    case "dots":
      return serializeDots(node, id);
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

function serializeImage(
  instance: ImageInstance,
  id: string | undefined,
  tellsErrors: boolean,
): ImageNode {
  const { source, resizeMode, style = {} } = instance.props;
  // An image that listens for its failure has an id for the host to name, patching or not.
  const listens = tellsErrors && instance.props.onError !== undefined;
  const named = listens ? instance.key : id;
  const props: ImageNode["props"] =
    named === undefined ? { src: source } : { id: named, src: source };
  if (style.width !== undefined) props.width = style.width;
  if (style.height !== undefined) props.height = style.height;
  if ((style.flex ?? 0) >= 1) props.fill = true;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (resizeMode === "cover") props.cover = true;
  if (listens) props.onError = true;
  return { type: "image", props };
}

/** A count as the host takes it: a whole number from 0. */
function count(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function serializeDots(instance: DotsInstance, id: string | undefined): DotsNode {
  const p = instance.props;
  const props: DotsNode["props"] = {
    ...(id === undefined ? {} : { id }),
    count: count(p.count) ?? 0,
    pitch: p.pitch,
    radius: p.radius,
  };
  const rows = count(p.rows);
  if (rows !== undefined) props.rows = rows;
  const lit = count(p.lit);
  if (lit !== undefined) props.lit = lit;
  if (p.color) props.color = p.color;
  if (p.unlitColor) props.unlitColor = p.unlitColor;
  const head = count(p.head);
  if (head !== undefined) props.head = head;
  if (p.headColor) props.headColor = p.headColor;
  if (p.headRing) props.headRing = true;
  if (p.cells !== undefined) props.cells = p.cells;
  if (p.opacity !== undefined) props.opacity = p.opacity;
  return { type: "dots", props };
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

/** A tab size as the renderer takes it: whole, from 1 to 64; none unless it is a number. */
function tabStops(size: number | undefined): number | undefined {
  if (typeof size !== "number" || !Number.isFinite(size)) return undefined;
  return Math.min(Math.max(Math.round(size), 1), 64);
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
  const weight = style.fontWeight === undefined ? undefined : WEIGHT[style.fontWeight];
  if (weight !== undefined && weight !== "normal") props.weight = weight;
  if (style.fontFamily === "monospace") props.mono = true;
  if (style.fontFamily === "display") props.display = true;
  if (numberOfLines === 1) props.truncate = true;
  if (style.opacity !== undefined) props.opacity = style.opacity;
  if (style.textAlign && style.textAlign !== "left") props.align = style.textAlign;
  if (style.fontStyle === "italic") props.italic = true;
  if (style.textDecorationLine === "underline") props.underline = true;
  if (style.textDecorationLine === "line-through") props.lineThrough = true;
  if (style.lineHeight !== undefined) props.lineHeight = style.lineHeight;
  const tabSize = tabStops(style.tabSize);
  if (tabSize !== undefined) props.tabSize = tabSize;
  return { type: "text", props, children };
}

/** A styled run as the renderer takes it (`InputRun`). */
interface InputRunProps {
  start: number;
  end: number;
  color?: Color;
  background?: Color;
  weight?: "normal" | FontWeightName;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  size?: number;
  press?: boolean;
  mono?: boolean;
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
  if (run.fontFamily) props.mono = run.fontFamily === "monospace";
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
  if (instance.base !== undefined) props.baseHash = instance.base;
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
  if (input.multiline && input.tabBehavior === "insert") props.insertTab = true;
  if (input.multiline && input.tabBehavior === "insert" && input.onShiftTab)
    props.shiftTabKey = true;
  const tabSize = tabStops(input.tabSize);
  if (tabSize !== undefined) props.tabSize = tabSize;
  if (input.onKeyPress) props.onKey = true;
  if (input.selection) {
    props.selection = { start: offset(input.selection.start), end: offset(input.selection.end) };
    if (instance.selectedIn !== undefined) props.selection.textHash = instance.selectedIn;
  }
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
