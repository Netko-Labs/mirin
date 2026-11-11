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
import type { Container, HostInstance, HostNode } from "./instances.ts";
import { headJson, nodeKey } from "./serialize.ts";

/** The patch protocol this driver speaks (crates/mirin-metal `PATCH_PROTOCOL`). */
export const PATCH_PROTOCOL = 1;

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

  constructor(
    private readonly container: Container,
    private readonly send: (line: string) => void,
    private readonly fields: FieldTexts,
  ) {}

  /** The host applies patches of `version`: send the whole tree with every id now, patches after. */
  hostPatches(version: number): void {
    if (version !== PATCH_PROTOCOL || this.patching) return;
    this.patching = true;
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
        found = String(node.id);
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
    const wire = headJson(node, parent, { ids: this.patching, root: node === this.root });
    if (fields) {
      if (this.patching) node.wire = wire;
      this.nodes.set(nodeKey(node), node);
      if (node.kind === "input" && node.props.onSelectionChange) {
        fields.set(String(node.id), {
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
    for (const mutation of log.mutations) {
      const parent = mutation.parent;
      // The root's container itself changed: only a whole tree says that.
      if (parent.kind === "root") return null;
      // A `<Text>`'s strings are its text; inputs, icons and images have no children.
      if (parent.kind === "text") log.dirty.add(parent);
      // A parent the host doesn't hold is gone, or new with its children in its insert.
      if (parent.kind !== "view" || !this.holds(parent) || fresh.has(parent)) continue;
      const { child } = mutation;
      const parentId = JSON.stringify(nodeKey(parent));
      if (mutation.kind === "remove") {
        if (!this.holds(child)) continue;
        ops.push(`{"op":"remove","id":${JSON.stringify(nodeKey(child))}}`);
        this.forget(child);
        continue;
      }
      const { before } = mutation;
      if (before && !this.holds(before)) return null;
      const where = before ? `,"before":${JSON.stringify(nodeKey(before))}` : "";
      if (this.holds(child)) {
        ops.push(
          `{"op":"move","id":${JSON.stringify(nodeKey(child))},"parent":${parentId}${where}}`,
        );
      } else {
        const node = this.freshJson(child, parent, fresh);
        ops.push(`{"op":"insert","parent":${parentId}${where},"node":${node}}`);
      }
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

  /** A `set` op when the node's head is not what the host has. */
  private setOp(node: HostNode, fresh: Set<HostNode>, ops: string[]): void {
    if (!this.holds(node) || fresh.has(node)) return;
    const parent = node.parent && node.parent.kind !== "root" ? node.parent : null;
    const wire = headJson(node, parent, { ids: true, root: node === this.root });
    if (node.kind === "input") this.followField(node);
    if (wire === node.wire) return;
    node.wire = wire;
    ops.push(`{"op":"set","id":${JSON.stringify(nodeKey(node))},"node":${wire}}`);
  }

  /** A new subtree as JSON, now held by the host. */
  private freshJson(node: HostNode, parent: HostInstance, fresh: Set<HostNode>): string {
    fresh.add(node);
    const wire = headJson(node, parent, { ids: true, root: false });
    node.wire = wire;
    this.nodes.set(nodeKey(node), node);
    if (node.kind === "input") this.followField(node);
    if (node.kind !== "view") return wire;
    const children = node.children.map((child) => this.freshJson(child, node, fresh));
    return `${wire.slice(0, -1)},"children":[${children.join(",")}]}`;
  }

  /** A subtree the host no longer holds. */
  private forget(node: HostNode): void {
    const id = nodeKey(node);
    if (this.nodes.get(id) === node) this.nodes.delete(id);
    if (node.kind === "raw") return;
    if (node.kind === "input") this.fields.forget(id);
    for (const child of node.children) this.forget(child);
  }

  private followField(node: HostInstance & { kind: "input" }): void {
    const id = String(node.id);
    if (node.props.onSelectionChange) {
      this.fields.field(id, node.props.value, node.props.valueRevision);
    } else this.fields.forget(id);
  }

  private holds(node: HostNode): boolean {
    return this.nodes.get(nodeKey(node)) === node;
  }
}

/** The mounted root: the container's first host instance. */
function rootOf(container: Container): HostInstance | null {
  return container.children.find((child): child is HostInstance => child.kind !== "raw") ?? null;
}
