/**
 * Taps feeding the sink from native events and failures in the Worker itself.
 * `logger` and `rpc-server` record inline at their own chokepoints; renderer
 * events sourced from the DevTools protocol live in `renderer-taps.ts`.
 */

import type { NativeEvent } from "../../runtime.ts";
import { onAnyNativeEvent } from "../../runtime.ts";
import { firstError, formatArgs, formatStack } from "../../shared/format.ts";
import { record } from "../sink.ts";
import type { DevEventLevel } from "../types.ts";
import { redactUrl } from "./network.ts";

/** Types that fire continuously during drag/resize. Only the settled value is kept
 *  (trailing edge); recording each one would evict everything else from the buffer. */
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

/** How CEF's display handler prefixes the console line for an uncaught error. */
const UNCAUGHT = /^Uncaught\b/;

/** Renderer console output arrives as a native `webview.console` event, so it is
 *  re-sourced to `renderer` here. */
function recordConsole(event: NativeEvent, cdpCovers: CdpCoverage): void {
  const source = typeof event.source === "string" ? event.source : "";
  const line = typeof event.line === "number" ? event.line : 0;
  const window = asWindowId(event.id);
  const level = asLevel(event.level) ?? "info";
  const message = typeof event.message === "string" ? event.message : "";

  // Drop this stackless copy of an uncaught error only when CDP covers the window
  // and will report it as `exception` with a stack; before the bridge attaches,
  // this is the only reporter.
  if (level === "error" && UNCAUGHT.test(message) && cdpCovers(window)) return;

  record({
    src: "renderer",
    level,
    type: "console",
    msg: message,
    ...(window !== undefined ? { window } : {}),
    data: {
      ...(source.length > 0 ? { source } : {}),
      ...(line > 0 ? { line } : {}),
    },
  });
}

function recordNative(event: NativeEvent): void {
  const window = asWindowId(event.id);
  const data = detail(event);
  // A desktop OAuth redirect is delivered as a deep link (`app.open-url`), so a
  // credential can reach the stream through the native tap.
  if (typeof data.url === "string") data.url = redactUrl(data.url);
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

/** Whether the CDP bridge is attached to a window and therefore already reporting
 *  its uncaught errors as `exception` events with stacks. */
export type CdpCoverage = (window: number | undefined) => boolean;

export interface NativeTapOptions {
  /** Defaults to "never attached", which keeps every console line. */
  cdpCovers?: CdpCoverage;
}

/** Route one native event into the stream. Exported separately from
 *  `installNativeTap` so the routing is testable without a live core. */
export function nativeTapHandler(options: NativeTapOptions = {}): (event: NativeEvent) => void {
  const cdpCovers = options.cdpCovers ?? (() => false);
  return (event) => {
    if (event.type === "webview.console") {
      recordConsole(event, cdpCovers);
      return;
    }
    if (COALESCED.has(event.type)) {
      recordCoalesced(event);
      return;
    }
    recordNative(event);
  };
}

/** Subscribe to every native event. Safe to call before the runtime boots. */
export function installNativeTap(options: NativeTapOptions = {}): () => void {
  return onAnyNativeEvent(nativeTapHandler(options));
}

/** Record failures in the Worker itself. `uncaughtExceptionMonitor` observes
 *  without suppressing the crash; the rejection listener has no observer-only
 *  variant and takes over default reporting, so it re-reports to stderr itself. */
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
