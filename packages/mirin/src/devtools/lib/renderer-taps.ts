/**
 * Renderer taps over the DevTools protocol.
 *
 * The core's display handler already reports console output, so `consoleAPICalled`
 * is deliberately not forwarded — it would double every line. What CDP adds is
 * everything the console cannot express: exceptions with real stack traces, HTTP
 * traffic, and navigation.
 *
 * Split from `taps.ts` (which owns native and Worker taps) because these are a
 * distinct concern with a distinct source: every event here is `src: "renderer"`.
 */

import { devtoolsOptions } from "../options.ts";
import { record } from "../sink.ts";
import type { DevEventLevel } from "../types.ts";
import type { CdpEvent } from "./cdp.ts";
import { headersMs, redactHeaders, redactUrl, requestMethod, statusLevel } from "./network.ts";
import { asArray, asNumber, asRecord, asString } from "./parse.ts";

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
    // Redacted like `data.url` on the same event: a script loaded with a
    // credential in its query would otherwise be clear here and hidden there.
    const url = redactUrl(asString(frame.url) ?? "");
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
      ...(asString(details?.url) !== undefined
        ? { url: redactUrl(asString(details?.url) ?? "") }
        : {}),
      line: asNumber(details?.lineNumber) ?? 0,
    },
  });
}

function recordLogEntry(event: CdpEvent): void {
  const entry = asRecord(event.params.entry);
  if (entry === undefined) return;
  const source = asString(entry.source) ?? "";
  // Two sources here are already covered, and reporting them twice is worse than
  // not reporting them: console output by the core's display handler, and network
  // failures by the Network-domain taps below. The network duplicate also disagrees
  // with itself — `Log` grades every failed request `error`, where `recordResponse`
  // deliberately calls a 4xx a warning, and `mirin check` fails a run on any error.
  // What's left is what CDP alone reports: security, rendering, deprecation, …
  if (source === "console-api" || source === "network") return;
  record({
    src: "renderer",
    level: LOG_LEVELS[asString(entry.level) ?? ""] ?? "info",
    type: "log.entry",
    msg: asString(entry.text) ?? "",
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: {
      source,
      ...(asString(entry.url) !== undefined ? { url: redactUrl(asString(entry.url) ?? "") } : {}),
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

/**
 * Every request the page issues. Recorded at `debug` so ordinary traffic does not
 * crowd a default read of the stream, while still being there when the question is
 * "what did the app actually call?".
 */
function recordRequest(event: CdpEvent): void {
  if (!devtoolsOptions().network) return;
  const request = asRecord(event.params.request);
  const method = requestMethod(request?.method);
  const url = redactUrl(asString(request?.url) ?? "");
  record({
    src: "renderer",
    level: "debug",
    type: "network.request",
    msg: `→ ${method} ${url}`,
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: {
      // The handle for `Network.getResponseBody` over `POST /cdp` — bodies are
      // fetched on demand rather than captured into the stream.
      requestId: asString(event.params.requestId) ?? "",
      method,
      url,
      ...(asString(event.params.type) !== undefined ? { resourceType: event.params.type } : {}),
      headers: redactHeaders(request?.headers),
    },
  });
}

function recordResponse(event: CdpEvent): void {
  const response = asRecord(event.params.response);
  const status = asNumber(response?.status) ?? 0;
  // Turning `network` off silences ordinary traffic, never failures: `mirin check`
  // gates on error-level events, and an opt-out for noise must not quietly weaken
  // the thing that catches a broken app.
  if (!devtoolsOptions().network && status < 400) return;
  const url = redactUrl(asString(response?.url) ?? "");
  const ms = headersMs(response?.timing);
  record({
    src: "renderer",
    level: statusLevel(status),
    type: "network.response",
    msg: `← ${status} ${asString(response?.statusText) ?? ""} ${url}`.trim(),
    ...(event.window !== undefined ? { window: event.window } : {}),
    data: {
      requestId: asString(event.params.requestId) ?? "",
      status,
      url,
      ...(asString(response?.mimeType) !== undefined ? { mimeType: response?.mimeType } : {}),
      ...(ms !== undefined ? { ms } : {}),
      headers: redactHeaders(response?.headers),
    },
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
    // Redacted like every other URL in the stream. This is the sink that matters
    // most: OAuth's implicit flow returns `#access_token=…`, and a fragment never
    // reaches the network, so `frameNavigated` is the only event that sees it.
    msg: redactUrl(asString(frame?.url) ?? ""),
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
    case "Network.requestWillBeSent":
      recordRequest(event);
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
