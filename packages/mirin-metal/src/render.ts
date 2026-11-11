/**
 * Public entry: mount normal React onto a native transport. Each commit
 * sends the native renderer the host tree, or only what changed when the
 * host takes patches (`lib/tree-sync.ts`); events come back keyed by node id
 * and invoke the matching handler of that node's current props.
 */

import type { ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import { ConcurrentRoot } from "react-reconciler/constants";
import { ChromeStore, chromeFromEvent, withChrome } from "./chrome.ts";
import { FieldTexts } from "./lib/field-texts.ts";
import { hostConfig } from "./lib/host-config.ts";
import type { Container, HostInstance } from "./lib/instances.ts";
import { TreeSync } from "./lib/tree-sync.ts";
import type { Modifiers, NativeEvent, NativeRoot, NativeTransport } from "./types.ts";

/** What a host older than `MIRIN_METAL_FOCUS` reports: no keys held. */
const NO_MODIFIERS: Modifiers = { shift: false, control: false, alt: false, super: false };

const reconciler = ReactReconciler(hostConfig);
// Type-only cast: @types/react-reconciler 0.32 doesn't declare this 0.33 export.
const syncReconciler = reconciler as unknown as { flushSyncFromReconciler<R>(fn: () => R): R };

/** Events a person makes one at a time, whose updates must render before the next one (React DOM's discrete events). */
const DISCRETE: ReadonlySet<NativeEvent["type"]> = new Set([
  "press",
  "change",
  "submit",
  "key",
  "selection",
  "runpress",
  "keydown",
  "windowkey",
  "contextmenu",
  "drop",
]);

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
  const fields = new FieldTexts();
  const chrome = new ChromeStore();
  const container: Container = {
    kind: "root",
    children: [],
    onCommit() {
      sync.commit();
    },
  };
  const sync = new TreeSync(container, (line) => transport.send(line), fields);
  // A node's handlers are its current props: what the host was last sent.
  const view = (id: string) => {
    const node: HostInstance | undefined = sync.instance(id);
    return node?.kind === "view" ? node.props : undefined;
  };
  const input = (id: string) => {
    const node: HostInstance | undefined = sync.instance(id);
    return node?.kind === "input" ? node.props : undefined;
  };
  // A throwing handler is reported and the app keeps running, as in React DOM.
  // A discrete event (a press, a keystroke, a change) is handled at discrete
  // priority and its updates are rendered before the next event is handled,
  // as React DOM does: a press right after typing then sees the typed text,
  // not the handlers of a render that hadn't caught up yet.
  transport.onEvent((event) => {
    try {
      if (DISCRETE.has(event.type)) syncReconciler.flushSyncFromReconciler(() => dispatch(event));
      else dispatch(event);
    } catch (error) {
      reportError(error);
    }
  });
  function dispatch(event: NativeEvent): void {
    switch (event.type) {
      case "press":
        view(event.nodeId)?.onPress?.({
          bounds: event.bounds,
          modifiers: event.modifiers ?? NO_MODIFIERS,
        });
        break;
      case "change":
        fields.typed(event.nodeId, event.value);
        input(event.nodeId)?.onChangeText?.(event.value);
        break;
      case "submit":
        input(event.nodeId)?.onSubmitEditing?.(event.value);
        break;
      case "key":
        input(event.nodeId)?.onKeyPress?.(event.value);
        break;
      case "selection":
        // A selection in a text the app has since replaced is late: its offsets are not into the value.
        if (!fields.holds(event.nodeId, event.textHash)) break;
        input(event.nodeId)?.onSelectionChange?.({ start: event.start, end: event.end });
        break;
      case "runpress":
        input(event.nodeId)?.onRunPress?.({
          run: event.run,
          offset: event.offset,
          modifiers: event.modifiers,
        });
        break;
      case "hover":
        view(event.nodeId)?.onHoverChange?.(event.hovered, event.bounds);
        break;
      case "pointer": {
        const { nodeId: _id, type: _type, ...info } = event;
        view(event.nodeId)?.onPointer?.(info);
        break;
      }
      case "resize":
        view(event.nodeId)?.onLayout?.(event.bounds);
        break;
      case "contextmenu":
        view(event.nodeId)?.onContextMenu?.({
          x: event.x,
          y: event.y,
          modifiers: event.modifiers ?? NO_MODIFIERS,
        });
        break;
      case "keydown": {
        const { nodeId: _id, type: _type, ...info } = event;
        view(event.nodeId)?.onKeyDown?.(info);
        break;
      }
      case "windowkey": {
        const { nodeId: _id, type: _type, ...info } = event;
        view(event.nodeId)?.onWindowKeyDown?.(info);
        break;
      }
      case "wheel":
        view(event.nodeId)?.onWheel?.({ dx: event.dx, dy: event.dy });
        break;
      case "drop": {
        const { nodeId: _id, type: _type, ...info } = event;
        view(event.nodeId)?.onDrop?.(info);
        break;
      }
      case "chrome":
        chrome.set(chromeFromEvent(event));
        break;
      case "protocol":
        sync.hostPatches(event.patches);
        break;
      case "resync":
        sync.resync();
        break;
      case "layout":
      case "frame":
      case "close-request":
      case "visibility":
      case "typing":
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
      return sync.lastTree();
    },
    nodeId(testID) {
      return sync.nodeId(testID);
    },
  };
}
