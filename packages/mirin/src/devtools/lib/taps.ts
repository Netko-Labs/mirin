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
import type { CdpEvent } from "./cdp.ts";
import { asArray, asNumber, asRecord, asString } from "./parse.ts";

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
  const window = asWindowId(event.id);
  record({
    src: "renderer",
    level: asLevel(event.level) ?? "info",
    type: "console",
    msg: typeof event.message === "string" ? event.message : "",
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

// ---- renderer taps over CDP ----
//
// The core's display handler already reports console output, so `consoleAPICalled`
// is deliberately not forwarded here — it would double every line. What CDP adds
// is everything the console cannot express: exceptions with real stack traces,
// failed network requests, and navigation.

/** CDP's `Log.entryAdded` levels, mapped onto the devtools levels. */
const LOG_LEVELS: Record<string, DevEventLevel> = {
  verbose: "debug",
  info: "info",
  warning: "warn",
  error: "error",
};

/** Frames from a CDP stack trace, flattened to `fn (url:line:col)` strings. */
function stackFrames(trace: unknown): string[] {
  return (asArray(asRecord(trace)?.callFrames) ?? []).slice(0, 12).flatMap((entry) => {
    const frame = asRecord(entry);
    if (frame === undefined) return [];
    const fn = asString(frame.functionName);
    const url = asString(frame.url) ?? "";
    const line = asNumber(frame.lineNumber) ?? 0;
    const column = asNumber(frame.columnNumber) ?? 0;
    return [`${fn !== undefined && fn.length > 0 ? fn : "<anonymous>"} (${url}:${line}:${column})`];
  });
}

function recordException(event: CdpEvent): void {
  const details = asRecord(event.params.exceptionDetails);
  const thrown = asRecord(details?.exception);
  const message =
    asString(thrown?.description) ?? asString(details?.text) ?? "uncaught exception in webview";
  record({
    src: "renderer",
    level: "error",
    type: "exception",
    msg: message,
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: {
      stack: stackFrames(details?.stackTrace),
      ...(asString(details?.url) !== undefined ? { url: asString(details?.url) } : {}),
      line: asNumber(details?.lineNumber) ?? 0,
    },
  });
}

function recordLogEntry(event: CdpEvent): void {
  const entry = asRecord(event.params.entry);
  if (entry === undefined) return;
  const source = asString(entry.source) ?? "";
  // Console output is already covered by the core's display handler; only take the
  // browser-internal sources CDP alone reports (network, security, rendering, …).
  if (source === "console-api") return;
  record({
    src: "renderer",
    level: LOG_LEVELS[asString(entry.level) ?? ""] ?? "info",
    type: "log.entry",
    msg: asString(entry.text) ?? "",
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: {
      source,
      ...(asString(entry.url) !== undefined ? { url: asString(entry.url) } : {}),
      ...(asNumber(entry.lineNumber) !== undefined ? { line: asNumber(entry.lineNumber) } : {}),
    },
  });
}

function recordLoadingFailed(event: CdpEvent): void {
  const canceled = event.params.canceled === true;
  record({
    src: "renderer",
    // A cancelled request is usually the app's own doing (an aborted fetch).
    level: canceled ? "debug" : "warn",
    type: "network.failed",
    msg: `${asString(event.params.errorText) ?? "request failed"} (${asString(event.params.type) ?? "resource"})`,
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: {
      requestId: asString(event.params.requestId) ?? "",
      canceled,
      ...(asString(event.params.blockedReason) !== undefined
        ? { blockedReason: asString(event.params.blockedReason) }
        : {}),
    },
  });
}

function recordResponse(event: CdpEvent): void {
  const response = asRecord(event.params.response);
  const status = asNumber(response?.status) ?? 0;
  // Successful responses are noise; failures are exactly what a reader is after.
  if (status < 400) return;
  record({
    src: "renderer",
    level: status >= 500 ? "error" : "warn",
    type: "network.error",
    msg: `${status} ${asString(response?.statusText) ?? ""} ${asString(response?.url) ?? ""}`.trim(),
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: { status, url: asString(response?.url) ?? "" },
  });
}

function recordNavigation(event: CdpEvent): void {
  const frame = asRecord(event.params.frame);
  // Sub-frame navigations (iframes, about:blank shims) are not what a reader means
  // by "the window navigated".
  if (asString(frame?.parentId) !== undefined) return;
  record({
    src: "renderer",
    level: "info",
    type: "navigation",
    msg: asString(frame?.url) ?? "",
    ...(event.window !== undefined ? { window: event.window } : {}),
  });
}

/** Route one CDP event into the stream. Unhandled methods are ignored. */
export function recordCdpEvent(event: CdpEvent): void {
  switch (event.method) {
    case "Runtime.exceptionThrown":
      recordException(event);
      break;
    case "Log.entryAdded":
      recordLogEntry(event);
      break;
    case "Network.loadingFailed":
      recordLoadingFailed(event);
      break;
    case "Network.responseReceived":
      recordResponse(event);
      break;
    case "Page.frameNavigated":
      recordNavigation(event);
      break;
    default:
      break;
  }
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
