/**
 * Keep a host's tree in step with the committed instances. A host that
 * speaks the patch protocol (it says so with a `protocol` event) gets the
 * whole tree once, with an id on every node, and after that only what each
 * commit changed (`{"patch":[…]}`, crates/mirin-metal `patch/`); any other
 * host, or transport, gets the whole tree on every commit, as before.
 * Events come back by node id and are looked up in `nodes`.
 */

import { type CommitLog, takeLog } from "./commit-log.ts";
import type { FieldTexts } from "./field-texts.ts";
import type { Container, HostInstance, HostNode, HostParent, ViewInstance } from "./instances.ts";
import { longestIncreasing } from "./order.ts";
import { headJson } from "./serialize.ts";

/** The patch protocol this driver speaks (crates/mirin-metal `PATCH_PROTOCOL`). */
export const PATCH_PROTOCOL = 1;

/** React's moves in one view, at most, sent as it made them (each is one move). */
const FEWEST_FROM = 2;

type FieldList = Map<string, { value: string; revision: number | undefined }>;

export class TreeSync {
  /** What the host holds, by id: each node sent and not removed since. */
  private readonly nodes = new Map<string, HostNode>();
  private patching = false;
  /** The next send is the whole tree (the first, after a resync, a new root). */
  private wholeNext = true;
  private root: HostInstance | null = null;
  /** The newest whole tree, while it is what the host holds. */
  private last: string | null = null;
  /**
   * Nothing is sent until the host says which protocol it takes
   * (`lib/handshake.ts`): commits until then are held, and the tree goes
   * out once, when it says or when it is taken to never say.
   */
  private waiting: boolean;

  constructor(
    private readonly container: Container,
    private readonly send: (line: string) => void,
    private readonly fields: FieldTexts,
    options: { awaitHost?: boolean } = {},
  ) {
    this.waiting = options.awaitHost === true;
  }

  /** The host applies patches of `version`: send the whole tree with every id now, patches after. */
  hostPatches(version: number): void {
    const waited = this.waiting;
    this.waiting = false;
    if (version !== PATCH_PROTOCOL || this.patching) {
      if (waited) this.resync();
      return;
    }
    this.patching = true;
    this.resync();
  }

  /** The host said nothing in time: it takes whole trees; send the one held, if any. */
  hostSilent(): void {
    if (!this.waiting) return;
    this.waiting = false;
    this.resync();
  }

  /** Send the whole tree now (the host asked: a patch didn't apply). */
  resync(): void {
    this.wholeNext = true;
    const root = rootOf(this.container);
    if (root) this.sendWhole(root);
  }

  /** After a commit: send what it changed. */
  commit(): void {
    const log = takeLog();
    // Held for the host's word: the whole tree goes then, whatever this changed.
    if (this.waiting) return;
    const root = rootOf(this.container);
    if (!root) return;
    if (!this.patching || this.wholeNext || root !== this.root) {
      this.sendWhole(root);
      return;
    }
    // Worked out again when asked, from the instances: a check that it is
    // what the patches built (the tests do) must not read a cached copy.
    this.last = null;
    const line = this.patchLine(log);
    if (line === null) this.sendWhole(root);
    else if (line) this.send(line);
  }

  /** The mounted instance behind a node id, for its event. */
  instance(id: string): HostInstance | undefined {
    const node = this.nodes.get(id);
    return node && node.kind !== "raw" ? node : undefined;
  }

  /** The whole tree as the host now has it. */
  lastTree(): string | null {
    if (this.last === null && this.root) this.last = this.wholeJson(this.root, null, null);
    return this.last;
  }

  /** The node id of the last view or field with `testID`, in document order. */
  nodeId(testID: string): string | undefined {
    let found: string | undefined;
    const visit = (node: HostNode): void => {
      if (node.kind === "raw") return;
      if ((node.kind === "view" || node.kind === "input") && node.props.testID === testID) {
        found = node.key;
      }
      for (const child of node.children) visit(child);
    };
    if (this.root) visit(this.root);
    return found;
  }

  private sendWhole(root: HostInstance): void {
    this.root = root;
    this.wholeNext = false;
    this.nodes.clear();
    const fields: FieldList = new Map();
    const json = this.wholeJson(root, null, fields);
    this.fields.follow(fields);
    this.last = json;
    this.send(json);
  }

  /** A node and its subtree as JSON; with `fields`, also what the host now holds. */
  private wholeJson(node: HostNode, parent: HostInstance | null, fields: FieldList | null): string {
    const root = node === this.root;
    // A view's or an input's head is its props and nothing else (the root's
    // also says it fills the window): one written from these very props is
    // still right. Only a tree that is sent reads it; `lastTree()` works
    // every head out again, so a check against it reads no kept copy.
    const kept = !root && (node.kind === "view" || node.kind === "input") ? node : null;
    const wire =
      fields && kept && kept.head !== undefined && kept.headProps === kept.props
        ? kept.head
        : headJson(node, parent, { ids: this.patching, root });
    if (fields) {
      if (kept) {
        kept.head = wire;
        kept.headProps = kept.props;
      }
      if (this.patching) node.wire = wire;
      this.nodes.set(node.key, node);
      if (node.kind === "input" && node.props.onSelectionChange) {
        fields.set(node.key, {
          value: node.props.value,
          revision: node.props.valueRevision,
        });
      }
    }
    if (node.kind !== "view") return wire;
    const children = node.children.map((child) => this.wholeJson(child, node, fields));
    return `${wire.slice(0, -1)},"children":[${children.join(",")}]}`;
  }

  /** The commit as a patch line; "" when it changed nothing sent; null when only a whole tree says it. */
  private patchLine(log: CommitLog): string | null {
    const ops: string[] = [];
    const fresh = new Set<HostNode>();
    const reordered = this.reordered(log);
    for (const mutation of log.mutations) {
      const parent = mutation.parent;
      // The root's container itself changed: only a whole tree says that.
      if (parent.kind === "root") return null;
      // A `<Text>`'s strings are its text; inputs, icons and images have no children.
      if (parent.kind === "text") log.dirty.add(parent);
      // A parent the host doesn't hold is gone, or new with its children in its insert.
      if (parent.kind !== "view" || !this.holds(parent) || fresh.has(parent)) continue;
      const { child } = mutation;
      if (mutation.kind === "remove") {
        if (!this.holds(child)) continue;
        ops.push(`{"op":"remove","id":"${child.key}"}`);
        this.forget(child);
        continue;
      }
      // A view whose children moved: its new order goes once, below.
      if (reordered.has(parent)) continue;
      // Ids are digits, or "r" and digits: nothing in them to escape.
      const parentId = `"${parent.key}"`;
      const { before } = mutation;
      if (before && !this.holds(before)) return null;
      const where = before ? `,"before":"${before.key}"` : "";
      if (this.holds(child)) {
        ops.push(`{"op":"move","id":"${child.key}","parent":${parentId}${where}}`);
      } else {
        const node = this.freshJson(child, parent, fresh);
        ops.push(`{"op":"insert","parent":${parentId}${where},"node":${node}}`);
      }
    }
    for (const parent of reordered) {
      if (!this.reorder(parent, log.before.get(parent), fresh, ops)) return null;
    }
    for (const node of log.dirty) {
      this.setOp(node, fresh, ops);
      // A view's strings are drawn in its `textStyle`.
      if (node.kind === "view") {
        for (const child of node.children) if (child.kind === "raw") this.setOp(child, fresh, ops);
      }
    }
    return ops.length > 0 ? `{"patch":[${ops.join(",")}]}` : "";
  }

  /**
   * The views the host holds whose children React moved in this commit, more
   * than `FEWEST_FROM` of them: a move or two goes as React made it.
   */
  private reordered(log: CommitLog): Set<ViewInstance> {
    let moves: Map<ViewInstance, number> | null = null;
    for (const mutation of log.mutations) {
      const parent: HostParent = mutation.parent;
      if (mutation.kind === "place" && parent.kind === "view" && this.holds(mutation.child)) {
        moves ??= new Map();
        moves.set(parent, (moves.get(parent) ?? 0) + 1);
      }
    }
    const views = new Set<ViewInstance>();
    if (moves) for (const [view, count] of moves) if (count > FEWEST_FROM) views.add(view);
    return views;
  }

  /**
   * A view's children in their new order, from the order the host holds
   * (`before`, less what this commit removed), in the fewest moves: those on
   * a longest run already in order stay, each other one moves before the
   * child that follows it now, and new ones go in there, last to first. React
   * moves every row between two it swaps; this sends two. False when a held
   * child came from another parent (React never moves one there).
   */
  private reorder(
    parent: ViewInstance,
    before: HostNode[] | undefined,
    fresh: Set<HostNode>,
    ops: string[],
  ): boolean {
    if (!this.holds(parent) || fresh.has(parent)) return true;
    if (!before) return false;
    for (let slot = 0; slot < before.length; slot += 1) (before[slot] as HostNode).slot = slot;
    const children = parent.children;
    const order = new Int32Array(children.length);
    let held = 0;
    for (const node of children) {
      if (!this.holds(node)) continue;
      // Where it was among the children the host holds; not there, it came from elsewhere.
      if (before[node.slot] !== node) return false;
      order[held] = node.slot;
      held += 1;
    }
    const stays = longestIncreasing(order.subarray(0, held), before.length);
    const parentId = `"${parent.key}"`;
    let next: HostNode | null = null;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const node = children[index] as HostNode;
      const where = next ? `,"before":"${next.key}"` : "";
      if (!this.holds(node)) {
        const json = this.freshJson(node, parent, fresh);
        ops.push(`{"op":"insert","parent":${parentId}${where},"node":${json}}`);
      } else if (stays[node.slot] !== 1) {
        ops.push(`{"op":"move","id":"${node.key}","parent":${parentId}${where}}`);
      }
      next = node;
    }
    return true;
  }

  /** A `set` op when the node's head is not what the host has. */
  private setOp(node: HostNode, fresh: Set<HostNode>, ops: string[]): void {
    if (!this.holds(node) || fresh.has(node)) return;
    const parent = node.parent && node.parent.kind !== "root" ? node.parent : null;
    const wire = headJson(node, parent, { ids: true, root: node === this.root });
    if (node.kind === "input") this.followField(node);
    if (wire === node.wire) return;
    node.wire = wire;
    ops.push(`{"op":"set","id":"${node.key}","node":${wire}}`);
  }

  /** A new subtree as JSON, now held by the host. */
  private freshJson(node: HostNode, parent: HostInstance, fresh: Set<HostNode>): string {
    fresh.add(node);
    const wire = headJson(node, parent, { ids: true, root: false });
    node.wire = wire;
    this.nodes.set(node.key, node);
    if (node.kind === "input") this.followField(node);
    if (node.kind !== "view") return wire;
    const children = node.children.map((child) => this.freshJson(child, node, fresh));
    return `${wire.slice(0, -1)},"children":[${children.join(",")}]}`;
  }

  /** A subtree the host no longer holds. */
  private forget(node: HostNode): void {
    const id = node.key;
    if (this.nodes.get(id) === node) this.nodes.delete(id);
    if (node.kind === "raw") return;
    if (node.kind === "input") this.fields.forget(id);
    for (const child of node.children) this.forget(child);
  }

  private followField(node: HostInstance & { kind: "input" }): void {
    const id = node.key;
    if (node.props.onSelectionChange) {
      this.fields.field(id, node.props.value, node.props.valueRevision);
    } else this.fields.forget(id);
  }

  private holds(node: HostNode): boolean {
    return this.nodes.get(node.key) === node;
  }
}

/** The mounted root: the container's first host instance. */
function rootOf(container: Container): HostInstance | null {
  return container.children.find((child): child is HostInstance => child.kind !== "raw") ?? null;
}
