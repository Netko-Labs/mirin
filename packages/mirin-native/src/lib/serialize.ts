/**
 * Committed instance tree → the JSON element tree the native renderer
 * understands (crates/mirin-native `tree.rs`), plus the press-handler map
 * keyed by the node ids stamped into that tree.
 */

import type { HostInstance, HostNode, TextInstance, ViewInstance } from "./instances.ts";

interface ViewNodeProps {
  id?: string;
  direction?: "row" | "column";
  gap?: number;
  padding?: number;
  width?: number;
  height?: number;
  fill?: boolean;
  center?: boolean;
  background?: string;
  cornerRadius?: number;
  onPress?: boolean;
}

interface TextNodeProps {
  color?: string;
  size?: number;
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

type TreeNode = ViewNode | TextNode;

export interface SerializedUi {
  treeJson: string;
  pressHandlers: Map<string, () => void>;
}

/** Serialize the committed root, or null when nothing is mounted. */
export function serializeRoot(children: HostNode[]): SerializedUi | null {
  const root = children.find((child): child is HostInstance => child.kind !== "raw");
  if (!root) {
    return null;
  }
  const pressHandlers = new Map<string, () => void>();
  const tree = serializeInstance(root, pressHandlers);
  return { treeJson: JSON.stringify(tree), pressHandlers };
}

function serializeInstance(instance: HostInstance, handlers: Map<string, () => void>): TreeNode {
  return instance.kind === "view" ? serializeView(instance, handlers) : serializeText(instance);
}

function serializeView(instance: ViewInstance, handlers: Map<string, () => void>): ViewNode {
  const style = instance.props.style ?? {};
  const props: ViewNodeProps = {};
  if (style.flexDirection) props.direction = style.flexDirection;
  if (style.gap !== undefined) props.gap = style.gap;
  if (style.padding !== undefined) props.padding = style.padding;
  if (style.width !== undefined) props.width = style.width;
  if (style.height !== undefined) props.height = style.height;
  if ((style.flex ?? 0) >= 1) props.fill = true;
  if (style.alignItems === "center" && style.justifyContent === "center") props.center = true;
  if (style.backgroundColor) props.background = style.backgroundColor;
  if (style.borderRadius !== undefined) props.cornerRadius = style.borderRadius;

  const { onPress } = instance.props;
  if (onPress) {
    const nodeId = String(instance.id);
    props.id = nodeId;
    props.onPress = true;
    handlers.set(nodeId, onPress);
  }

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
  const children = instance.children
    .filter((child): child is Extract<HostNode, { kind: "raw" }> => child.kind === "raw")
    .map((child) => child.text);
  return { type: "text", props, children };
}
