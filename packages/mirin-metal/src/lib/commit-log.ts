/**
 * What the commit in progress changed: the host-config's mutations, in the
 * order React made them, and the nodes whose props or text changed. The
 * root that commits takes it in `resetAfterCommit` (`lib/tree-sync.ts`).
 * Commits never interleave, so one log serves every root.
 */

import type { HostNode, HostParent } from "./instances.ts";

export type Mutation =
  | { kind: "place"; parent: HostParent; child: HostNode; before: HostNode | null }
  | { kind: "remove"; parent: HostParent; child: HostNode };

export interface CommitLog {
  mutations: Mutation[];
  /** Nodes whose head may have changed (props, a string's text). */
  dirty: Set<HostNode>;
  /**
   * Each view's children as they were before the commit first changed them:
   * the order the host holds, from which a reorder is sent in the fewest
   * moves (`lib/tree-sync.ts`).
   */
  before: Map<HostParent, HostNode[]>;
}

const emptyLog = (): CommitLog => ({ mutations: [], dirty: new Set(), before: new Map() });
let current: CommitLog = emptyLog();
/** The view whose children were last noted (a commit's changes mostly come a list at a time). */
let noted: HostParent | null = null;

export function logMutation(mutation: Mutation): void {
  current.mutations.push(mutation);
}

/** A view's children are about to change: keep their order as it was, once a commit. */
export function noteChildren(parent: HostParent): void {
  if (parent === noted || parent.kind !== "view") return;
  noted = parent;
  if (!current.before.has(parent)) current.before.set(parent, parent.children.slice());
}

/** A node's head may have changed; a string in a `<Text>` changes the text node. */
export function logDirty(node: HostNode): void {
  const parent = node.parent;
  current.dirty.add(node.kind === "raw" && parent?.kind === "text" ? parent : node);
}

/** The commit's log, leaving an empty one for the next. */
export function takeLog(): CommitLog {
  const log = current;
  current = emptyLog();
  noted = null;
  return log;
}

/**
 * How many keys a node's props had when they were last compared, and its
 * `style`: counted then, so the next compare walks only the new props (a
 * re-rendered node's props and style are new objects with the same keys).
 * -1 when not known (never compared, or they differed).
 */
export interface PropCounts {
  propCount: number;
  styleCount: number;
}

/**
 * Whether two props objects send the same head, as far as a cheap look can
 * tell: the same keys, each value the same, a function for a function (a
 * handler is read when its event comes, never sent), or a shallowly equal
 * object (a `style` written inline). `children` is the reconciler's. False
 * may still send the same head; the caller compares what it sends.
 * `counts` are `prev`'s, and become `next`'s.
 */
export function sameProps(prev: object, next: object, counts: PropCounts): boolean {
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  let keys = 0;
  for (const key in after) {
    if (key === "children") continue;
    keys += 1;
    const a = before[key];
    const b = after[key];
    if (a === b) {
      // One style object kept across renders: counted again when it isn't.
      if (key === "style") counts.styleCount = -1;
      continue;
    }
    if (typeof a === "function" && typeof b === "function") continue;
    if (key === "style") {
      const count = sameValues(a, b, counts.styleCount);
      if (count < 0) return differ(counts);
      counts.styleCount = count;
    } else if (sameValues(a, b, -1) < 0) return differ(counts);
  }
  let old = counts.propCount;
  if (old < 0) {
    old = 0;
    for (const key in before) if (key !== "children") old += 1;
  }
  if (keys !== old) return differ(counts);
  counts.propCount = keys;
  return true;
}

function differ(counts: PropCounts): false {
  counts.propCount = -1;
  counts.styleCount = -1;
  return false;
}

/**
 * `b`'s number of keys when `a` and `b` are objects with the same keys and
 * values, else -1; `known` is `a`'s number of keys, or -1 to count them.
 */
function sameValues(a: unknown, b: unknown, known: number): number {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return -1;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let keys = 0;
  for (const key in right) {
    keys += 1;
    if (left[key] !== right[key]) return -1;
  }
  let count = known;
  if (count < 0) {
    count = 0;
    for (const _ in left) count += 1;
  }
  return keys === count ? keys : -1;
}
