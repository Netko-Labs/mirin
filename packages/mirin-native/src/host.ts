/**
 * Stdio transport: spawn the `mirin-native-host` binary
 * (crates/mirin-native/src/bin/host.rs) and speak newline-delimited JSON —
 * trees out on its stdin, events in from its stdout. Stands in for the
 * eventual in-process FFI transport.
 */

import type { NativeEvent, NativeTransport } from "./types.ts";

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
  if (record.type !== "press" || typeof record.nodeId !== "string") {
    return null;
  }
  return { type: "press", nodeId: record.nodeId };
}

export function spawnNativeHost(binaryPath: string): NativeTransport {
  const child = Bun.spawn([binaryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const listeners: Array<(event: NativeEvent) => void> = [];

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
    close() {
      void child.stdin.end();
      child.kill();
    },
  };
}
