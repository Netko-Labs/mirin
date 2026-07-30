/**
 * Taps that feed the devtools sink from sources the sink cannot reach on its own.
 *
 * The other two producers record inline where the signal already passes through
 * a single chokepoint: `logger` mirrors each emitted line, and `rpc-server`
 * traces every request. This module covers the rest — native events from the
 * core, and failures in the Worker itself.
 */

import type { NativeEvent } from "../../runtime.ts";
import { onAnyNativeEvent } from "../../runtime.ts";
import { firstError, formatArgs, formatStack } from "../../shared/format.ts";
import { record } from "../sink.ts";
import type { DevEventLevel } from "../types.ts";

/**
 * Native event types that fire continuously while the user drags or resizes a
 * window. Recording each one would evict everything else from the ring buffer,
 * so only the settled value is kept (trailing edge).
 */
const COALESCED = new Set(["window.moved", "window.resized"]);

/** How long movement must stop before the settled geometry is recorded. */
const COALESCE_MS = 200;

const LEVELS: DevEventLevel[] = ["debug", "info", "warn", "error"];

function asLevel(value: unknown): DevEventLevel | undefined {
  return typeof value === "string" && (LEVELS as string[]).includes(value)
    ? (value as DevEventLevel)
    : undefined;
}

function asWindowId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Everything except `type`/`id`, which are lifted into the envelope. */
function detail(event: NativeEvent): Record<string, unknown> {
  const { type: _type, id: _id, ...rest } = event;
  return rest;
}

/**
 * Renderer console output arrives as a native `webview.console` event (the core's
 * display handler forwards it), so it is re-sourced to `renderer` here rather
 * than reported as a native event.
 */
function recordConsole(event: NativeEvent): void {
  const source = typeof event.source === "string" ? event.source : "";
  const line = typeof event.line === "number" ? event.line : 0;
  record({
    src: "renderer",
    level: asLevel(event.level) ?? "info",
    type: "console",
    msg: typeof event.message === "string" ? event.message : "",
    ...(asWindowId(event.id) !== undefined ? { window: asWindowId(event.id) } : {}),
    data: {
      ...(source.length > 0 ? { source } : {}),
      ...(line > 0 ? { line } : {}),
    },
  });
}

function recordNative(event: NativeEvent): void {
  const window = asWindowId(event.id);
  const data = detail(event);
  record({
    src: "native",
    // Geometry and paint chatter is debug; lifecycle is worth seeing by default.
    level: COALESCED.has(event.type) ? "debug" : "info",
    type: event.type,
    msg: event.type,
    ...(window !== undefined ? { window } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
}

/** Trailing-edge timers for coalesced event types, keyed `type:windowId`. */
const settling = new Map<string, ReturnType<typeof setTimeout>>();

function recordCoalesced(event: NativeEvent): void {
  const key = `${event.type}:${asWindowId(event.id) ?? 0}`;
  const existing = settling.get(key);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    settling.delete(key);
    recordNative(event);
  }, COALESCE_MS);
  // Diagnostics must never keep the Worker alive past the app's own lifetime.
  timer.unref?.();
  settling.set(key, timer);
}

/** Subscribe to every native event. Safe to call before the runtime boots. */
export function installNativeTap(): () => void {
  return onAnyNativeEvent((event) => {
    if (event.type === "webview.console") {
      recordConsole(event);
      return;
    }
    if (COALESCED.has(event.type)) {
      recordCoalesced(event);
      return;
    }
    recordNative(event);
  });
}

/**
 * Record failures in the Worker itself — the class of bug that otherwise leaves
 * an agent with a dead window and no explanation.
 *
 * `uncaughtExceptionMonitor` is an observer: it cannot suppress the default
 * crash, so attaching it changes nothing about how the app behaves. There is no
 * observer-only variant for rejections, and attaching a listener there *does*
 * take over the default reporting — so that one re-reports to stderr itself, and
 * the caller only installs these taps when devtools are enabled (dev runs), which
 * keeps packaged-build behavior untouched.
 */
export function installProcessTaps(): () => void {
  const onException = (err: unknown): void => {
    const error = err instanceof Error ? err : undefined;
    record({
      src: "main",
      level: "error",
      type: "uncaughtException",
      msg: formatArgs([err]),
      data: error !== undefined ? { stack: formatStack(error) } : {},
    });
  };

  const onRejection = (reason: unknown): void => {
    const error = firstError([reason]);
    record({
      src: "main",
      level: "error",
      type: "unhandledRejection",
      msg: formatArgs([reason]),
      data: error !== undefined ? { stack: formatStack(error) } : {},
    });
    // Preserve the visibility the default handler would have provided.
    console.error("[mirin] unhandled rejection:", reason);
  };

  process.on("uncaughtExceptionMonitor", onException);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("uncaughtExceptionMonitor", onException);
    process.off("unhandledRejection", onRejection);
  };
}
