/**
 * Stdio transport: spawn the `mirin-metal-host` binary
 * (crates/mirin-metal/src/bin/host.rs) and speak newline-delimited JSON —
 * trees out on its stdin, events in from its stdout. Stands in for the
 * eventual in-process FFI transport.
 */

import type { LayoutNode, NativeEvent, NativeTransport } from "./types.ts";

/** Parse one NDJSON line from the host into a typed event, or null. */
export function parseNativeEvent(line: string): NativeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.nodeId !== "string") {
    return null;
  }
  const nodeId = record.nodeId;
  switch (record.type) {
    case "press":
      return { type: "press", nodeId };
    case "layout":
      return Array.isArray(record.nodes)
        ? { type: "layout", nodeId: "root", nodes: record.nodes.flatMap(parseLayoutNode) }
        : null;
    case "change":
    case "submit":
      return typeof record.value === "string"
        ? { type: record.type, nodeId, value: record.value }
        : null;
    default:
      return null;
  }
}

function parseLayoutNode(value: unknown): LayoutNode[] {
  if (typeof value !== "object" || value === null) return [];
  const node = value as Record<string, unknown>;
  const { id, x, y, width, height } = node;
  if (typeof id !== "string") return [];
  if ([x, y, width, height].some((n) => typeof n !== "number")) return [];
  return [{ id, x: x as number, y: y as number, width: width as number, height: height as number }];
}

export function spawnNativeHost(binaryPath: string): NativeTransport {
  const child = Bun.spawn([binaryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const listeners: Array<(event: NativeEvent) => void> = [];
  const closeListeners: Array<() => void> = [];
  void child.exited.then(() => {
    for (const listener of closeListeners) {
      listener();
    }
  });

  void (async () => {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseNativeEvent(line);
        if (event) {
          for (const listener of listeners) {
            listener(event);
          }
        }
      }
    }
  })();

  return {
    send(treeJson) {
      child.stdin.write(`${treeJson}\n`);
      void child.stdin.flush();
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    simulate(command) {
      child.stdin.write(`${JSON.stringify({ sim: command })}\n`);
      void child.stdin.flush();
    },
    close() {
      void child.stdin.end();
      child.kill();
    },
  };
}
