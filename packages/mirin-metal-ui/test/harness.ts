/**
 * Headless harness: mount a React tree on a fake transport (no window), read
 * the JSON tree the renderer would receive, and fire the events the native
 * side would send (press, change, hover, pointer, resize). Every `onLayout`
 * node gets a synthetic resize after each commit so popups become visible.
 */

import type { NativeEvent, NativeTransport, SimCommand } from "@mirinjs/metal";
import { render } from "@mirinjs/metal";
import type { ReactNode } from "react";

export interface TreeNode {
  type: string;
  props: Record<string, unknown>;
  children?: Array<TreeNode | string>;
}

export interface Harness {
  /** The last committed tree. */
  tree(): TreeNode;
  /** Every string rendered anywhere in the tree, in order. */
  texts(): string[];
  hasText(text: string): boolean;
  press(testID: string): Promise<void>;
  pressText(text: string): Promise<void>;
  type(testID: string, value: string): Promise<void>;
  hover(testID: string, hovered: boolean): Promise<void>;
  settle(): Promise<void>;
  nodeId(testID: string): string | undefined;
  unmount(): void;
}

const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };

export async function mount(element: ReactNode): Promise<Harness> {
  const listeners: Array<(event: NativeEvent) => void> = [];
  let last = "";
  const transport: NativeTransport = {
    send(treeJson) {
      last = treeJson;
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    onClose() {},
    simulate(_command: SimCommand) {},
    close() {},
  };
  const emit = (event: NativeEvent) => {
    for (const listener of listeners) listener(event);
  };
  const root = render(element, transport);
  const seenLayout = new Set<string>();

  const walk = (node: TreeNode | string, visit: (node: TreeNode) => void) => {
    if (typeof node === "string") return;
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
  };

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await Bun.sleep(5);
      if (!last) continue;
      const tree = JSON.parse(last) as TreeNode;
      let fired = false;
      walk(tree, (node) => {
        const id = node.props.id;
        if (node.props.onLayout && typeof id === "string" && !seenLayout.has(id)) {
          seenLayout.add(id);
          fired = true;
          emit({ type: "resize", nodeId: id, bounds: { ...WINDOW, width: 200, height: 120 } });
        }
      });
      if (!fired) break;
    }
    await Bun.sleep(5);
  };

  const tree = () => JSON.parse(last || '{"type":"view","props":{}}') as TreeNode;
  const texts = () => {
    const out: string[] = [];
    walk(tree(), (node) => {
      if (node.type === "text") out.push((node.children ?? []).join(""));
      if (node.type === "input") out.push(String(node.props.value ?? ""));
    });
    return out;
  };
  const findIdByText = (text: string): string | undefined => {
    let found: string | undefined;
    const visit = (node: TreeNode | string, pressable: string | undefined) => {
      if (typeof node === "string" || found) return;
      const id =
        node.props.onPress && typeof node.props.id === "string" ? node.props.id : pressable;
      if (node.type === "text" && (node.children ?? []).join("") === text && id) found = id;
      for (const child of node.children ?? []) visit(child, id);
    };
    visit(tree(), undefined);
    return found;
  };

  await settle();
  return {
    tree,
    texts,
    hasText: (text) => texts().some((value) => value.includes(text)),
    async press(testID) {
      const id = root.nodeId(testID);
      if (!id) throw new Error(`no node with testID ${testID}`);
      emit({ type: "press", nodeId: id, bounds: { x: 10, y: 10, width: 80, height: 30 } });
      await settle();
    },
    async pressText(text) {
      const id = findIdByText(text);
      if (!id) throw new Error(`no pressable node containing text ${JSON.stringify(text)}`);
      emit({ type: "press", nodeId: id, bounds: { x: 10, y: 10, width: 80, height: 30 } });
      await settle();
    },
    async type(testID, value) {
      const id = root.nodeId(testID);
      if (!id) throw new Error(`no node with testID ${testID}`);
      emit({ type: "change", nodeId: id, value });
      await settle();
    },
    async hover(testID, hovered) {
      const id = root.nodeId(testID);
      if (!id) throw new Error(`no node with testID ${testID}`);
      emit({ type: "hover", nodeId: id, hovered, bounds: { x: 10, y: 10, width: 80, height: 30 } });
      await settle();
    },
    settle,
    nodeId: (testID) => root.nodeId(testID),
    unmount: () => root.unmount(),
  };
}
