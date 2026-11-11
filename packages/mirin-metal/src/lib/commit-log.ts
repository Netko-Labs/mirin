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
}

let current: CommitLog = { mutations: [], dirty: new Set() };

export function logMutation(mutation: Mutation): void {
  current.mutations.push(mutation);
}

/** A node's head may have changed; a string in a `<Text>` changes the text node. */
export function logDirty(node: HostNode): void {
  const parent = node.parent;
  current.dirty.add(node.kind === "raw" && parent?.kind === "text" ? parent : node);
}

/** The commit's log, leaving an empty one for the next. */
export function takeLog(): CommitLog {
  const log = current;
  current = { mutations: [], dirty: new Set() };
  return log;
}

/**
 * Whether two props objects send the same head, as far as a cheap look can
 * tell: the same keys, each value the same, a function for a function (a
 * handler is read when its event comes, never sent), or a shallowly equal
 * object (a `style` written inline). `children` is the reconciler's. False
 * may still send the same head; the caller compares what it sends.
 */
export function sameProps(prev: object, next: object): boolean {
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  let keys = 0;
  for (const key in after) {
    if (key === "children") continue;
    keys += 1;
    const a = before[key];
    const b = after[key];
    if (a === b || (typeof a === "function" && typeof b === "function")) continue;
    if (!shallowEqual(a, b)) return false;
  }
  for (const key in before) if (key !== "children") keys -= 1;
  return keys === 0;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let keys = 0;
  for (const key in right) {
    keys += 1;
    if (left[key] !== right[key]) return false;
  }
  for (const _ in left) keys -= 1;
  return keys === 0;
}
