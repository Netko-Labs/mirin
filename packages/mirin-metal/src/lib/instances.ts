/** Internal host-instance tree the reconciler mutates between commits. */

import type { ImageProps, SvgProps, TextInputProps, TextProps, ViewProps } from "../types.ts";
import type { PropCounts } from "./commit-log.ts";

/** What every host instance has: its identity, where it is, and its last head sent. */
interface InstanceBase extends PropCounts {
  /** Stable per-mount identity; keys events across the boundary. */
  id: number;
  /** The id as the tree and its events spell it (`String(id)`), made once. */
  key: string;
  children: HostNode[];
  /** The instance or container it is attached to; null while detached. */
  parent: HostParent | null;
  /** Its head (`lib/serialize.ts`) as a patching host last got it. */
  wire?: string;
  /** Where it was in its parent's children before a reorder (`lib/tree-sync.ts`); -1 until one. */
  slot: number;
  /**
   * A view's or an input's head as a whole tree last wrote it, and the props
   * it was written from: their head says nothing but their props, so the
   * next whole tree writes it again only for props React has replaced.
   */
  head?: string;
  headProps?: object;
}

export interface ViewInstance extends InstanceBase {
  kind: "view";
  props: ViewProps;
}

export interface TextInstance extends InstanceBase {
  kind: "text";
  props: TextProps;
}

export interface InputInstance extends InstanceBase {
  kind: "input";
  props: TextInputProps;
}

/** A raw string/number child, e.g. the text inside `<Text>`. */
export interface RawTextInstance {
  kind: "raw";
  text: string;
  /** Its id as a text node of its own, when placed directly in a view ("r1", "r2", …). */
  key: string;
  parent: HostParent | null;
  wire?: string;
  slot: number;
}

export interface SvgInstance extends InstanceBase {
  kind: "svg";
  props: SvgProps;
}

export interface ImageInstance extends InstanceBase {
  kind: "image";
  props: ImageProps;
}

export type HostInstance =
  | ViewInstance
  | TextInstance
  | InputInstance
  | SvgInstance
  | ImageInstance;
export type HostNode = HostInstance | RawTextInstance;
/** What a node is attached to: another instance, or a root's container (a portal's target is an instance). */
export type HostParent = HostInstance | Container;

export interface Container {
  kind: "root";
  children: HostNode[];
  /** Invoked after each commit; the renderer serializes and sends from here. */
  onCommit: () => void;
}

/**
 * Where a child was last taken out of a list, and where one was last put
 * in. A commit's mutations mostly walk one list in order (rows removed one
 * after the other, rows inserted before the same sibling, a reorder), so the
 * next child is nearly always beside the last one: looking there first keeps
 * a commit of n mutations from searching the list n times.
 */
interface Hint {
  list: HostNode[] | null;
  index: number;
}
const taken: Hint = { list: null, index: 0 };
const put: Hint = { list: null, index: 0 };

function indexNear(list: HostNode[], node: HostNode, hint: Hint): number {
  if (hint.list === list) {
    const at = hint.index;
    if (list[at] === node) return at;
    if (list[at + 1] === node) return at + 1;
    if (at > 0 && list[at - 1] === node) return at - 1;
  }
  return list.indexOf(node);
}

/** Drop the hints (a commit is over; its lists may be gone). */
export function forgetHints(): void {
  taken.list = null;
  put.list = null;
}

export function removeNode(list: HostNode[], child: HostNode): void {
  const index = indexNear(list, child, taken);
  if (index >= 0) {
    list.splice(index, 1);
    taken.list = list;
    taken.index = index;
  }
}

/** Put `child` before `before`; `attached` says it is in the list already (a move). */
export function insertNodeBefore(
  list: HostNode[],
  child: HostNode,
  before: HostNode,
  attached: boolean,
): void {
  if (attached) removeNode(list, child);
  const index = indexNear(list, before, put);
  if (index >= 0) {
    list.splice(index, 0, child);
    put.list = list;
    put.index = index;
  } else {
    list.push(child);
  }
}
