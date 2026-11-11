/**
 * The tree a patching host keeps: whole trees replace it, patches change it
 * in place, applied as crates/mirin-metal `patch/document.rs` does and
 * failing as loudly. The harness mounts every test through it, so each
 * component's updates are also checked as patches.
 */

export interface WireNode {
  type: string;
  props: Record<string, unknown>;
  children?: Array<WireNode | string>;
}

type Op =
  | { op: "insert"; parent: string; before?: string; node: WireNode }
  | { op: "move"; id: string; parent: string; before?: string }
  | { op: "remove"; id: string }
  | { op: "set"; id: string; node: WireNode };

export class PatchedTree {
  tree: WireNode | null = null;

  /** Take one line the driver sent. */
  take(line: string): void {
    const value = JSON.parse(line) as WireNode | { patch: Op[] };
    if (!("patch" in value)) {
      this.tree = value;
      return;
    }
    if (!this.tree) throw new Error("a patch before any tree");
    for (const op of value.patch) apply(this.tree, op);
  }
}

function find(
  node: WireNode,
  id: string,
  parent: WireNode | null,
): [WireNode, WireNode | null] | null {
  if (node.props.id === id) return [node, parent];
  for (const child of node.children ?? []) {
    if (typeof child === "string") continue;
    const found = find(child, id, node);
    if (found) return found;
  }
  return null;
}

function at(tree: WireNode, id: string): [WireNode, WireNode | null] {
  const found = find(tree, id, null);
  if (!found) throw new Error(`patch: no node ${id}`);
  return found;
}

function childIndex(parent: WireNode, id: string): number {
  const index = (parent.children ?? []).findIndex(
    (child) => typeof child !== "string" && child.props.id === id,
  );
  if (index < 0) throw new Error(`patch: ${id} is not a child of ${String(parent.props.id)}`);
  return index;
}

function insert(parent: WireNode, node: WireNode, before: string | undefined): void {
  if (parent.type !== "view") throw new Error("patch: children go under views");
  parent.children ??= [];
  const index = before ? childIndex(parent, before) : parent.children.length;
  parent.children.splice(index, 0, node);
}

function apply(tree: WireNode, op: Op): void {
  switch (op.op) {
    case "insert": {
      if (find(tree, String(op.node.props.id), null)) {
        throw new Error(`patch: ${String(op.node.props.id)} is already in the tree`);
      }
      insert(at(tree, op.parent)[0], op.node, op.before);
      return;
    }
    case "remove": {
      const [, parent] = at(tree, op.id);
      if (!parent) throw new Error("patch: the root stays");
      parent.children?.splice(childIndex(parent, op.id), 1);
      return;
    }
    case "move": {
      const [node, from] = at(tree, op.id);
      if (!from) throw new Error("patch: the root stays");
      from.children?.splice(childIndex(from, op.id), 1);
      insert(at(tree, op.parent)[0], node, op.before);
      return;
    }
    case "set": {
      const [node] = at(tree, op.id);
      if (node.type !== op.node.type || op.node.props.id !== op.id) {
        throw new Error(`patch: set ${op.id} must keep its type and id`);
      }
      node.props = op.node.props;
      if (node.type !== "view") node.children = op.node.children;
    }
  }
}
