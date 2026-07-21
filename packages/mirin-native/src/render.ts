/**
 * Public entry: mount normal React onto a native transport. Each commit
 * serializes the host tree and sends it to the native renderer; press events
 * come back keyed by node id and invoke the matching `onPress`.
 */

import type { ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import { ConcurrentRoot } from "react-reconciler/constants";
import { hostConfig } from "./lib/host-config.ts";
import type { Container } from "./lib/instances.ts";
import { serializeRoot } from "./lib/serialize.ts";
import type { NativeRoot, NativeTransport } from "./types.ts";

const reconciler = ReactReconciler(hostConfig);

function reportError(error: Error): void {
  console.error("[mirin-native]", error);
}

/** Render a React element tree into the native UI. */
export function render(element: ReactNode, transport: NativeTransport): NativeRoot {
  let pressHandlers = new Map<string, () => void>();
  const container: Container = {
    children: [],
    onCommit() {
      const serialized = serializeRoot(container.children);
      if (!serialized) {
        return;
      }
      pressHandlers = serialized.pressHandlers;
      transport.send(serialized.treeJson);
    },
  };
  transport.onEvent((event) => {
    if (event.type === "press") {
      pressHandlers.get(event.nodeId)?.();
    }
  });

  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "mirin-native",
    reportError,
    reportError,
    reportError,
    () => {},
    null,
  );
  reconciler.updateContainer(element, root, null, null);

  return {
    unmount() {
      reconciler.updateContainer(null, root, null, null);
      transport.close();
    },
  };
}
