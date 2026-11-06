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
  Modifiers,
  NativeEvent,
  NativeHostTransport,
  TitleBarStyle,
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
  if (record.type === "chrome") {
    return parseChromeEvent(record);
  }
  if (record.type === "frame") {
    return record.nodeId === "root" ? { type: "frame", nodeId: "root" } : null;
  }
  const nodeId = record.nodeId;
  const bounds = parseBounds(record.bounds);
  const withBounds = bounds ? { bounds } : {};
  switch (record.type) {
    case "press": {
      const modifiers = parseModifiers(record);
      return { type: "press", nodeId, ...withBounds, ...(modifiers ? { modifiers } : {}) };
    }
    case "visibility":
      return nodeId === "root" && typeof record.visible === "boolean"
        ? { type: "visibility", nodeId: "root", visible: record.visible }
        : null;
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
    case "contextmenu": {
      if (typeof record.x !== "number" || typeof record.y !== "number") return null;
      const modifiers = parseModifiers(record);
      return {
        type: "contextmenu",
        nodeId,
        x: record.x,
        y: record.y,
        ...(modifiers ? { modifiers } : {}),
      };
    }
    case "layout":
      return Array.isArray(record.nodes)
        ? { type: "layout", nodeId: "root", nodes: record.nodes.flatMap(parseLayoutNode) }
        : null;
    case "change":
    case "submit":
      return typeof record.value === "string"
        ? { type: record.type, nodeId, value: record.value }
        : null;
    case "keydown":
    case "windowkey": {
      const { key, text, ctrl, alt, shift, meta, repeat, pasted } = record;
      if (typeof key !== "string") return null;
      const info = {
        key,
        ...(typeof text === "string" ? { text } : {}),
        ctrl: ctrl === true,
        alt: alt === true,
        shift: shift === true,
        meta: meta === true,
        repeat: repeat === true,
      };
      return record.type === "keydown"
        ? { type: "keydown", nodeId, ...info }
        : { type: "windowkey", nodeId, ...info, ...(typeof pasted === "string" ? { pasted } : {}) };
    }
    case "wheel":
      return typeof record.dx === "number" && typeof record.dy === "number"
        ? { type: "wheel", nodeId, dx: record.dx, dy: record.dy }
        : null;
    case "drop": {
      const { phase, x, y, paths, ctrl, alt, shift } = record;
      if (phase !== "enter" && phase !== "over" && phase !== "leave" && phase !== "drop")
        return null;
      if (typeof x !== "number" || typeof y !== "number") return null;
      return {
        type: "drop",
        nodeId,
        phase,
        x,
        y,
        paths: Array.isArray(paths)
          ? paths.filter((path): path is string => typeof path === "string")
          : [],
        ctrl: ctrl === true,
        alt: alt === true,
        shift: shift === true,
      };
    }
    case "key":
      return record.value === "Escape" || record.value === "ArrowUp" || record.value === "ArrowDown"
        ? { type: "key", nodeId, value: record.value }
        : null;
    default:
      return null;
  }
}

/** The modifiers a press or a right-click carries (`meta` is Super); undefined from an older host that sends none. */
function parseModifiers(record: Record<string, unknown>): Modifiers | undefined {
  const { shift, ctrl, alt, meta } = record;
  if ([shift, ctrl, alt, meta].every((held) => held === undefined)) return undefined;
  return { shift: shift === true, control: ctrl === true, alt: alt === true, super: meta === true };
}

function parseChromeEvent(record: Record<string, unknown>): NativeEvent | null {
  const { titleBar } = record;
  if (titleBar !== "standard" && titleBar !== "unified") return null;
  if (record.controls === null) return { type: "chrome", nodeId: "root", titleBar, controls: null };
  const controls = parseBounds(record.controls);
  return controls ? { type: "chrome", nodeId: "root", titleBar, controls } : null;
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
  /**
   * The screen to show on, by its output name ("eDP-1", "DP-2"); the
   * compositor picks when unset or when no screen has that name. For a
   * surface on every screen, open one host per screen.
   */
  output?: string;
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
   * The app's name for screen readers: what Orca says for the application
   * (`MIRIN_METAL_APP_NAME`). Defaults to the first window's title. A host
   * from before it ignores it.
   */
  appName?: string;
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
  /**
   * `"unified"` runs the app's content up to the window's top edge, with the
   * compositor's window controls drawn over it (`MIRIN_METAL_TITLEBAR`;
   * default `"standard"`). Only Dashi's compositor does this; elsewhere it
   * falls back to the standard title bar. Read the result with
   * `useWindowChrome()`.
   */
  titleBar?: TitleBarStyle;
  /** Extra environment for the host process. */
  env?: Record<string, string>;
  /**
   * Start the host with no window (`MIRIN_METAL_DEFERRED`): its GPU context
   * and fonts load now, and `open()` on the transport shows the window at
   * once later. A shell keeps one warm this way for its menus and sheets.
   * The window options here (title, size, surface, …) are then ignored.
   */
  deferred?: boolean;
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
  if (options.deferred) env.MIRIN_METAL_DEFERRED = "1";
  if (options.title !== undefined && !options.deferred) env.MIRIN_METAL_TITLE = options.title;
  if (options.appId !== undefined) env.MIRIN_METAL_APP_ID = options.appId;
  if (options.appName !== undefined) env.MIRIN_METAL_APP_NAME = options.appName;
  if (options.capabilities !== undefined) {
    env.MIRIN_METAL_CAPABILITIES = options.capabilities.join(",");
  }
  if (options.width !== undefined && options.height !== undefined) {
    env.MIRIN_METAL_SIZE = `${Math.round(options.width)}x${Math.round(options.height)}`;
  }
  if (options.surface !== undefined) env.MIRIN_METAL_SURFACE = JSON.stringify(options.surface);
  if (options.titleBar !== undefined) env.MIRIN_METAL_TITLEBAR = options.titleBar;
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
    setTitle(title) {
      child.stdin.write(`${JSON.stringify({ title })}\n`);
      void child.stdin.flush();
    },
    open(window) {
      child.stdin.write(`${JSON.stringify({ open: window })}\n`);
      void child.stdin.flush();
    },
    hide() {
      child.stdin.write('{"hide":true}\n');
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
