/**
 * Stdio transport: spawn the `mirin-metal-host` binary
 * (crates/mirin-metal/src/bin/host.rs) and speak newline-delimited JSON —
 * trees out on its stdin, events in from its stdout. Stands in for the
 * eventual in-process FFI transport.
 */

import { markAnnounces } from "./lib/handshake.ts";
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
  if (record.type === "frame" || record.type === "close-request") {
    return record.nodeId === "root" ? { type: record.type, nodeId: "root" } : null;
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
    case "protocol":
      return nodeId === "root" && typeof record.patches === "number"
        ? {
            type: "protocol",
            nodeId: "root",
            patches: record.patches,
            ...(record.settle === true ? { settle: true } : {}),
            ...(record.activation === true ? { activation: true } : {}),
            ...(record.rebase === true ? { rebase: true } : {}),
            ...(record.selectionHash === true ? { selectionHash: true } : {}),
            ...(record.noSelectionEcho === true ? { noSelectionEcho: true } : {}),
            ...(record.revisionRebase === true ? { revisionRebase: true } : {}),
            ...(record.scroll === true ? { scroll: true } : {}),
            ...(record.imageError === true ? { imageError: true } : {}),
            ...(record.opaqueSurface === true ? { opaqueSurface: true } : {}),
          }
        : null;
    case "settled":
      return nodeId === "root" && typeof record.quiet === "boolean"
        ? {
            type: "settled",
            nodeId: "root",
            quiet: record.quiet,
            ...(typeof record.scene === "string" ? { scene: record.scene } : {}),
            ...(typeof record.frames === "string" ? { frames: record.frames } : {}),
          }
        : null;
    case "resync":
      return nodeId === "root"
        ? {
            type: "resync",
            nodeId: "root",
            reason: typeof record.value === "string" ? record.value : "",
          }
        : null;
    case "typing":
      return nodeId === "root" && typeof record.typing === "boolean"
        ? { type: "typing", nodeId: "root", typing: record.typing }
        : null;
    case "hover":
      return typeof record.hovered === "boolean"
        ? { type: "hover", nodeId, hovered: record.hovered, ...withBounds }
        : null;
    case "pointer": {
      const { phase, x, y } = record;
      if (phase !== "down" && phase !== "move" && phase !== "up") return null;
      if (typeof x !== "number" || typeof y !== "number") return null;
      const modifiers = parseModifiers(record);
      return {
        type: "pointer",
        nodeId,
        phase,
        x,
        y,
        ...withBounds,
        ...(modifiers ? { modifiers } : {}),
      };
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
    case "runpress": {
      const { run, offset } = record;
      if (
        typeof run !== "number" ||
        typeof offset !== "number" ||
        !Number.isInteger(run) ||
        run < 0 ||
        offset < 0
      )
        return null;
      const modifiers = parseModifiers(record) ?? {
        shift: false,
        control: false,
        alt: false,
        super: false,
      };
      return { type: "runpress", nodeId, run, offset, modifiers };
    }
    case "scroll": {
      const { x, y, contentWidth, contentHeight, width, height } = record;
      const numbers = [x, y, contentWidth, contentHeight, width, height];
      if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
        return null;
      }
      const [left, top, wide, tall, viewWidth, viewHeight] = numbers as number[];
      return {
        type: "scroll",
        nodeId,
        x: left as number,
        y: top as number,
        contentWidth: wide as number,
        contentHeight: tall as number,
        width: viewWidth as number,
        height: viewHeight as number,
      };
    }
    case "imageerror":
      return typeof record.value === "string"
        ? { type: "imageerror", nodeId, error: record.value }
        : null;
    case "selection": {
      const { start, end, textHash } = record;
      if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start)
        return null;
      return typeof textHash === "number"
        ? { type: "selection", nodeId, start, end, textHash }
        : { type: "selection", nodeId, start, end };
    }
    case "change": {
      const { value, baseHash, textHash } = record;
      if (typeof value !== "string") return null;
      return {
        type: "change",
        nodeId,
        value,
        ...(typeof baseHash === "number" ? { baseHash } : {}),
        ...(typeof textHash === "number" ? { textHash } : {}),
      };
    }
    case "submit":
      return typeof record.value === "string"
        ? { type: "submit", nodeId, value: record.value }
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

/** The modifiers a press, a right-click or a pointer phase carries (`meta` is Super); undefined from an older host that sends none. */
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
 * no other options but `opaque`; it unlocks only through `unlock()`.
 */
export type SurfaceOptions = LayerSurfaceOptions | LockSurfaceOptions;

export interface LockSurfaceOptions {
  role: "lock";
  /** As a layer surface's (`LayerSurfaceOptions.opaque`). */
  opaque?: boolean;
}

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
  /**
   * The app paints every pixel of the surface, with no alpha (a bar with a
   * solid background, a login screen). It is then opened opaque, as a window
   * is: the compositor need not blend it over what is behind, and its text
   * can be antialiased by subpixels (`textAntialiasing: "subpixel"`), which
   * needs the colour behind each glyph to be the surface's own. Whatever is
   * left unpainted is black, and a translucent color is over black, so a
   * surface with rounded corners, a shadow or a see-through background is
   * not one. Default false: transparent where its tree is, text in grays.
   * A host from before it (no `opaqueSurface` in its `protocol` event; the
   * binary does not name `MIRIN_METAL_OPAQUE_SURFACE`) refuses a surface
   * that says it, so a deferred host's is asked only after that event.
   */
  opaque?: boolean;
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
  /**
   * The smallest the person can make the window, in px
   * (`MIRIN_METAL_MIN_SIZE`, `xdg_toplevel.set_min_size`): an app whose layout
   * stops working below it. Both or neither. Windows only; a host from before
   * it ignores it.
   */
  minWidth?: number;
  minHeight?: number;
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
  /**
   * Answer closes from outside (the compositor's close control, a shell's
   * close or quit) yourself (`MIRIN_METAL_CLOSE=ask`): the window stays and
   * a `close-request` event arrives; `close()` closes it, or the app asks
   * first (unsaved changes, a running job). A host from before it closes at
   * once. Windows only; ignored for surfaces and deferred hosts.
   */
  askToClose?: boolean;
  /**
   * How the host antialiases text (`MIRIN_METAL_TEXT`): `"grayscale"`, the
   * default on Linux and the supported one, or `"subpixel"` (sharper on a
   * panel of horizontal red, green, blue stripes; colour fringes on any
   * other, and in a screenshot). Unset, the driver's own environment
   * decides, else the host's default. It is chosen here, as the host
   * starts, and holds for its life: a host kept warm (`deferred`) opens
   * every window in it, and changing it means a new host. A window that is
   * not opaque (a layer or lock surface that does not say `opaque`) draws
   * grays either way.
   */
  textAntialiasing?: "grayscale" | "subpixel";
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
  if (options.minWidth !== undefined && options.minHeight !== undefined) {
    env.MIRIN_METAL_MIN_SIZE = `${Math.max(1, Math.round(options.minWidth))}x${Math.max(1, Math.round(options.minHeight))}`;
  }
  if (options.surface !== undefined) env.MIRIN_METAL_SURFACE = JSON.stringify(options.surface);
  if (options.titleBar !== undefined) env.MIRIN_METAL_TITLEBAR = options.titleBar;
  if (options.askToClose) env.MIRIN_METAL_CLOSE = "ask";
  if (options.textAntialiasing !== undefined) env.MIRIN_METAL_TEXT = options.textAntialiasing;
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
  // The host's word on patches, kept: it is said once, as the host starts,
  // and a host kept warm said it long before anything rendered into it.
  let protocol: NativeEvent | null = null;
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
          if (event.type === "protocol") protocol = event;
          for (const listener of listeners) {
            listener(event);
          }
        }
      }
    }
  })();

  // The host's first line says which patch protocol it takes (or a host
  // from before patches says nothing): the first tree waits for it.
  return markAnnounces<NativeHostTransport>({
    send(treeJson) {
      child.stdin.write(`${treeJson}\n`);
      void child.stdin.flush();
    },
    onEvent(listener) {
      listeners.push(listener);
      // A listener that comes after the host's word hears it now: `render`
      // would otherwise wait `HOST_WORD_MS` for it and never patch.
      if (protocol) listener(protocol);
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
    setSize(width, height) {
      const size = {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
      child.stdin.write(`${JSON.stringify({ size })}\n`);
      void child.stdin.flush();
    },
    setMinSize(width, height) {
      const minSize = {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
      child.stdin.write(`${JSON.stringify({ minSize })}\n`);
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
  });
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
