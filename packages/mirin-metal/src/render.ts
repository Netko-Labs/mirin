/**
 * Public entry: mount normal React onto a native transport. Each commit
 * serializes the host tree and sends it to the native renderer; press events
 * come back keyed by node id and invoke the matching `onPress`.
 */

import type { ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import { ConcurrentRoot } from "react-reconciler/constants";
import { ChromeStore, chromeFromEvent, withChrome } from "./chrome.ts";
import { hostConfig } from "./lib/host-config.ts";
import type { Container } from "./lib/instances.ts";
import { type Handlers, serializeRoot } from "./lib/serialize.ts";
import type { NativeEvent, NativeRoot, NativeTransport } from "./types.ts";

const reconciler = ReactReconciler(hostConfig);

function reportError(error: unknown): void {
  console.error("[mirin-metal]", error);
}

/**
 * Render `children` into another mounted host view (a portal). Context flows
 * through as in React DOM portals; overlays use it to escape clipping.
 */
export function createPortal(children: ReactNode, container: unknown, key?: string): ReactNode {
  // Type-only cast: the reconciler types the container as its Container, but
  // any mounted host instance (which also has `children`) works as a target.
  // Type-only cast: react-reconciler ships its own ReactPortal declaration that
  // does not overlap @types/react's; the runtime object is the same.
  return reconciler.createPortal(
    children,
    container as Container,
    null,
    key ?? null,
  ) as unknown as ReactNode;
}

/** Render a React element tree into the native UI. */
export function render(element: ReactNode, transport: NativeTransport): NativeRoot {
  let handlers: Handlers = {
    press: new Map(),
    hover: new Map(),
    pointer: new Map(),
    contextMenu: new Map(),
    keyDown: new Map(),
    wheel: new Map(),
    drop: new Map(),
    layout: new Map(),
    change: new Map(),
    submit: new Map(),
    key: new Map(),
    testIds: new Map(),
  };
  let lastTree: string | null = null;
  const chrome = new ChromeStore();
  const container: Container = {
    children: [],
    onCommit() {
      const serialized = serializeRoot(container.children);
      if (!serialized) {
        return;
      }
      handlers = serialized.handlers;
      lastTree = serialized.treeJson;
      transport.send(serialized.treeJson);
    },
  };
  // A throwing handler is reported and the app keeps running, as in React DOM.
  transport.onEvent((event) => {
    try {
      dispatch(event);
    } catch (error) {
      reportError(error);
    }
  });
  function dispatch(event: NativeEvent): void {
    switch (event.type) {
      case "press":
        handlers.press.get(event.nodeId)?.({ bounds: event.bounds });
        break;
      case "change":
        handlers.change.get(event.nodeId)?.(event.value);
        break;
      case "submit":
        handlers.submit.get(event.nodeId)?.(event.value);
        break;
      case "key":
        handlers.key.get(event.nodeId)?.(event.value);
        break;
      case "hover":
        handlers.hover.get(event.nodeId)?.(event.hovered, event.bounds);
        break;
      case "pointer": {
        const { nodeId: _id, type: _type, ...info } = event;
        handlers.pointer.get(event.nodeId)?.(info);
        break;
      }
      case "resize":
        handlers.layout.get(event.nodeId)?.(event.bounds);
        break;
      case "contextmenu":
        handlers.contextMenu.get(event.nodeId)?.({ x: event.x, y: event.y });
        break;
      case "keydown": {
        const { nodeId: _id, type: _type, ...info } = event;
        handlers.keyDown.get(event.nodeId)?.(info);
        break;
      }
      case "wheel":
        handlers.wheel.get(event.nodeId)?.({ dx: event.dx, dy: event.dy });
        break;
      case "drop": {
        const { nodeId: _id, type: _type, ...info } = event;
        handlers.drop.get(event.nodeId)?.(info);
        break;
      }
      case "chrome":
        chrome.set(chromeFromEvent(event));
        break;
      case "layout":
        break;
    }
  }

  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "mirin-metal",
    reportError,
    reportError,
    reportError,
    () => {},
    null,
  );
  reconciler.updateContainer(withChrome(chrome, element), root, null, null);

  return {
    unmount() {
      reconciler.updateContainer(null, root, null, null);
      transport.close();
    },
    lastTree() {
      return lastTree;
    },
    nodeId(testID) {
      return handlers.testIds.get(testID);
    },
  };
}
