/**
 * Stdio transport: spawn the `mirin-metal-host` binary
 * (crates/mirin-metal/src/bin/host.rs) and speak newline-delimited JSON —
 * trees out on its stdin, events in from its stdout. Stands in for the
 * eventual in-process FFI transport.
 */

import { parseToplevelEvent, toplevelCommand } from "./lib/toplevels.ts";
import type {
  Bounds,
  LayoutNode,
  NativeEvent,
  NativeHostTransport,
  ToplevelEvent,
} from "./types.ts";

/** One NDJSON line from the host as an object, or null. */
function parseRecord(line: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse one NDJSON line from the host into a typed event, or null. */
export function parseNativeEvent(line: string): NativeEvent | null {
  const record = parseRecord(line);
  return record ? nativeEventFromRecord(record) : null;
}

function nativeEventFromRecord(record: Record<string, unknown>): NativeEvent | null {
  if (typeof record.nodeId !== "string") {
    return null;
  }
  const nodeId = record.nodeId;
  const bounds = parseBounds(record.bounds);
  const withBounds = bounds ? { bounds } : {};
  switch (record.type) {
    case "press":
      return { type: "press", nodeId, ...withBounds };
    case "hover":
      return typeof record.hovered === "boolean"
        ? { type: "hover", nodeId, hovered: record.hovered, ...withBounds }
        : null;
    case "pointer": {
      const { phase, x, y } = record;
      if (phase !== "down" && phase !== "move" && phase !== "up") return null;
      if (typeof x !== "number" || typeof y !== "number") return null;
      return { type: "pointer", nodeId, phase, x, y, ...withBounds };
    }
    case "resize":
      return bounds ? { type: "resize", nodeId, bounds } : null;
    case "contextmenu":
      return typeof record.x === "number" && typeof record.y === "number"
        ? { type: "contextmenu", nodeId, x: record.x, y: record.y }
        : null;
    case "layout":
      return Array.isArray(record.nodes)
        ? { type: "layout", nodeId: "root", nodes: record.nodes.flatMap(parseLayoutNode) }
        : null;
    case "change":
    case "submit":
      return typeof record.value === "string"
        ? { type: record.type, nodeId, value: record.value }
        : null;
    case "key":
      return record.value === "Escape" || record.value === "ArrowUp" || record.value === "ArrowDown"
        ? { type: "key", nodeId, value: record.value }
        : null;
    default:
      return null;
  }
}

function parseBounds(value: unknown): Bounds | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if ([x, y, width, height].some((n) => typeof n !== "number")) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function parseLayoutNode(value: unknown): LayoutNode[] {
  if (typeof value !== "object" || value === null) return [];
  const node = value as Record<string, unknown>;
  const { id, x, y, width, height } = node;
  if (typeof id !== "string") return [];
  if ([x, y, width, height].some((n) => typeof n !== "number")) return [];
  return [{ id, x: x as number, y: y as number, width: width as number, height: height as number }];
}

/**
 * A Wayland layer-shell surface (a panel, a dock, a launcher) instead of a
 * window: the `windows.*.surface` shape from docs/api-design.md §1a. A
 * `{ role: "lock" }` surface locks the session (ext-session-lock) and takes
 * no other options; it unlocks only through `unlock()`.
 */
export type SurfaceOptions = LayerSurfaceOptions | { role: "lock" };

export interface LayerSurfaceOptions {
  role?: "layer";
  /** Stacking layer; default `top`. */
  layer?: "background" | "bottom" | "top" | "overlay";
  /** Output edges to attach to; both opposite edges stretch along that axis. */
  anchor?: Array<"top" | "bottom" | "left" | "right">;
  /** Px other windows avoid along the anchored edge; -1 ignores other zones. */
  exclusiveZone?: number;
  /** Keyboard focus policy; default `none`. */
  keyboard?: "none" | "on-demand" | "exclusive";
  /** Px from the anchored edges. */
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  /** The surface's purpose for the compositor; defaults to the title. */
  namespace?: string;
}

export interface NativeHostOptions {
  /** Window title (`MIRIN_METAL_TITLE`). */
  title?: string;
  /**
   * App id the compositor groups windows by, usually the manifest `id`
   * (`MIRIN_METAL_APP_ID`).
   */
  appId?: string;
  /**
   * Privileged APIs (`MIRIN_METAL_CAPABILITIES`). `shell.toplevels` follows
   * every window and enables `onToplevel` and `toplevel()` on the transport.
   */
  capabilities?: Array<"shell.toplevels">;
  /** Initial window size in px (`MIRIN_METAL_SIZE`). */
  width?: number;
  height?: number;
  /** Open a layer-shell surface instead of a window (`MIRIN_METAL_SURFACE`). */
  surface?: SurfaceOptions;
  /** Extra environment for the host process. */
  env?: Record<string, string>;
  /**
   * Receive the host's stderr line by line (logs, `MIRIN_METAL_TRACE` timing)
   * instead of inheriting it.
   */
  onStderr?: (line: string) => void;
}

export function spawnNativeHost(
  binaryPath: string,
  options: NativeHostOptions = {},
): NativeHostTransport {
  // Bun.spawn's default environment is the one the process started with;
  // pass the live `process.env` so runtime assignments reach the host.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (options.title !== undefined) env.MIRIN_METAL_TITLE = options.title;
  if (options.appId !== undefined) env.MIRIN_METAL_APP_ID = options.appId;
  if (options.capabilities !== undefined) {
    env.MIRIN_METAL_CAPABILITIES = options.capabilities.join(",");
  }
  if (options.width !== undefined && options.height !== undefined) {
    env.MIRIN_METAL_SIZE = `${Math.round(options.width)}x${Math.round(options.height)}`;
  }
  if (options.surface !== undefined) env.MIRIN_METAL_SURFACE = JSON.stringify(options.surface);
  Object.assign(env, options.env);
  const child = Bun.spawn([binaryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: options.onStderr ? "pipe" : "inherit",
    env,
  });
  if (options.onStderr && child.stderr instanceof ReadableStream) {
    void forwardLines(child.stderr, options.onStderr);
  }
  const listeners: Array<(event: NativeEvent) => void> = [];
  const toplevelListeners: Array<(event: ToplevelEvent) => void> = [];
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
        const record = parseRecord(line);
        if (!record) continue;
        const toplevel = parseToplevelEvent(record);
        if (toplevel) {
          for (const listener of toplevelListeners) listener(toplevel);
          continue;
        }
        const event = nativeEventFromRecord(record);
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
    onToplevel(listener) {
      toplevelListeners.push(listener);
    },
    toplevel(id, action) {
      child.stdin.write(`${toplevelCommand(id, action)}\n`);
      void child.stdin.flush();
    },
    unlock() {
      child.stdin.write('{"unlock":true}\n');
      void child.stdin.flush();
    },
    close() {
      void child.stdin.end();
      child.kill();
    },
  };
}

/** Read a byte stream as text and hand each complete line to `onLine`. */
async function forwardLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }
}
