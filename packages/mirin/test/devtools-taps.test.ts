import { describe, expect, test } from "bun:test";
import type { CdpEvent } from "../src/devtools/lib/cdp.ts";
import { recordCdpEvent } from "../src/devtools/lib/renderer-taps.ts";
import { nativeTapHandler } from "../src/devtools/lib/taps.ts";
import { resolveDevtoolsOptions, setDevtoolsOptions } from "../src/devtools/options.ts";
import { sink } from "../src/devtools/sink.ts";
import type { DevEvent } from "../src/devtools/types.ts";
import type { NativeEvent } from "../src/runtime.ts";

/** Events the taps publish while `run` executes. */
function captured(run: () => void): DevEvent[] {
  const events: DevEvent[] = [];
  const unsubscribe = sink.subscribe((event) => events.push(event));
  try {
    run();
  } finally {
    unsubscribe();
  }
  return events;
}

function logEntry(source: string, level: string, text: string): CdpEvent {
  return { method: "Log.entryAdded", params: { entry: { source, level, text } }, window: 1 };
}

function consoleEvent(level: string, message: string): NativeEvent {
  return { type: "webview.console", id: 1, level, message, source: "app.js", line: 12 };
}

describe("native console tap", () => {
  // An uncaught error is reported by both producers: the CEF display handler (no
  // stack) and CDP (`exception`, with one). Only the stackless copy is dropped,
  // and only where CDP is there to report the other.
  test("drops the stackless copy when CDP covers the window", () => {
    const handler = nativeTapHandler({ cdpCovers: () => true });
    const events = captured(() => handler(consoleEvent("error", "Uncaught Error: boom")));
    expect(events).toHaveLength(0);
  });

  // The bridge attaches after CEF binds its port, so an error thrown by the first
  // window's opening script can beat it. Dropping that one would lose it entirely.
  test("keeps it when CDP is not attached to that window", () => {
    const handler = nativeTapHandler({ cdpCovers: () => false });
    const events = captured(() => handler(consoleEvent("error", "Uncaught Error: boom")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "console", level: "error", window: 1 });
  });

  test("defaults to keeping everything when no coverage is supplied", () => {
    const events = captured(() => nativeTapHandler()(consoleEvent("error", "Uncaught Error: x")));
    expect(events).toHaveLength(1);
  });

  // The rule is narrow on purpose: ordinary output has no CDP counterpart.
  test("never drops ordinary console output", () => {
    const handler = nativeTapHandler({ cdpCovers: () => true });
    const events = captured(() => {
      handler(consoleEvent("info", "hello"));
      handler(consoleEvent("error", "request failed: 500"));
      handler(consoleEvent("warn", "Uncaught is only special at error level"));
    });
    expect(events.map((event) => event.msg)).toEqual([
      "hello",
      "request failed: 500",
      "Uncaught is only special at error level",
    ]);
  });

  test("re-sources console output to the renderer with its origin", () => {
    const events = captured(() => nativeTapHandler()(consoleEvent("warn", "deprecated")));
    expect(events[0]).toMatchObject({ src: "renderer", type: "console", level: "warn" });
    expect(events[0]?.data).toMatchObject({ source: "app.js", line: 12 });
  });
});

describe("cdp renderer taps", () => {
  // The bug this pins: a missing favicon produced *two* records of one 404 —
  // `network.error` at warn (4xx is not fatal) and `log.entry` at error — and
  // `mirin check` gates on error-level events, so every app failed its own check.
  test("reports a failed request once, at the network tap's severity", () => {
    const events = captured(() => {
      recordCdpEvent({
        method: "Network.responseReceived",
        params: {
          response: { status: 404, statusText: "Not Found", url: "http://127.0.0.1/favicon.ico" },
        },
        window: 1,
      });
      recordCdpEvent(
        logEntry("network", "error", "Failed to load resource: 404 (Not Found) /favicon.ico"),
      );
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "network.response", level: "warn" });
    expect(events.some((event) => event.level === "error")).toBe(false);
  });

  test("a 5xx is still an error", () => {
    const events = captured(() =>
      recordCdpEvent({
        method: "Network.responseReceived",
        params: { response: { status: 500, statusText: "Server Error", url: "http://x/api" } },
      }),
    );
    expect(events[0]).toMatchObject({ type: "network.response", level: "error" });
  });

  // Console output arrives separately as a native `webview.console` event.
  test("drops console-api entries", () => {
    expect(captured(() => recordCdpEvent(logEntry("console-api", "error", "boom")))).toHaveLength(
      0,
    );
  });

  // The filter must stay narrow: these sources have no other producer, so
  // dropping them would lose the signal entirely.
  test("keeps the sources only CDP reports", () => {
    const events = captured(() => {
      recordCdpEvent(logEntry("security", "error", "mixed content blocked"));
      recordCdpEvent(logEntry("rendering", "warning", "layout thrashing"));
    });
    expect(events.map((event) => `${event.type}:${event.level}`)).toEqual([
      "log.entry:error",
      "log.entry:warn",
    ]);
    expect(events[0]?.window).toBe(1);
  });

  test("an uncaught exception keeps its stack", () => {
    const events = captured(() =>
      recordCdpEvent({
        method: "Runtime.exceptionThrown",
        params: {
          exceptionDetails: {
            text: "Uncaught",
            lineNumber: 3,
            url: "http://127.0.0.1/main.tsx",
            exception: { description: "TypeError: nope" },
            stackTrace: {
              callFrames: [
                {
                  functionName: "boot",
                  url: "http://127.0.0.1/main.tsx",
                  lineNumber: 3,
                  columnNumber: 7,
                },
              ],
            },
          },
        },
      }),
    );
    expect(events[0]).toMatchObject({ type: "exception", level: "error", msg: "TypeError: nope" });
    expect(events[0]?.data).toMatchObject({
      stack: ["boot (http://127.0.0.1/main.tsx:3:7)"],
      line: 3,
    });
  });
});

describe("url sinks outside the network taps", () => {
  // A desktop OAuth redirect arrives as a deep link, not as an HTTP request, so
  // this reaches the stream with every renderer sink clean.
  test("a deep link's url is redacted", () => {
    const events = captured(() =>
      nativeTapHandler()({
        type: "app.open-url",
        url: "myapp://auth?code=abc#access_token=LIVE_TOKEN",
      } as NativeEvent),
    );

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("LIVE_TOKEN");
    expect(serialized).toContain("redacted");
  });

  test("stack frame urls are redacted like the event's own url", () => {
    const events = captured(() =>
      recordCdpEvent({
        method: "Runtime.exceptionThrown",
        params: {
          exceptionDetails: {
            url: "https://cdn.test/app.js?api_key=SECRET1",
            exception: { description: "TypeError: nope" },
            stackTrace: {
              callFrames: [
                {
                  functionName: "boot",
                  url: "https://cdn.test/app.js?api_key=SECRET2",
                  lineNumber: 1,
                  columnNumber: 1,
                },
              ],
            },
          },
        },
      }),
    );

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("SECRET1");
    expect(serialized).not.toContain("SECRET2");
  });
});

describe("http traffic", () => {
  const withNetwork = (enabled: boolean, run: () => void): DevEvent[] => {
    setDevtoolsOptions({ ...resolveDevtoolsOptions({ network: enabled }, true) });
    try {
      return captured(run);
    } finally {
      setDevtoolsOptions(resolveDevtoolsOptions(undefined, false));
    }
  };

  const request = (url: string, headers: Record<string, string> = {}): CdpEvent => ({
    method: "Network.requestWillBeSent",
    params: { requestId: "42.1", type: "XHR", request: { method: "post", url, headers } },
    window: 1,
  });

  test("records the request side, which nothing reported before", () => {
    const events = withNetwork(true, () =>
      recordCdpEvent(request("https://api.test/todos", { "content-type": "application/json" })),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "network.request", level: "debug", window: 1 });
    expect(events[0]?.msg).toBe("→ POST https://api.test/todos");
    // The handle for fetching the body on demand via POST /cdp.
    expect(events[0]?.data).toMatchObject({ requestId: "42.1", method: "POST" });
  });

  test("never writes a credential into the stream", () => {
    const events = withNetwork(true, () =>
      recordCdpEvent(
        request("https://api.test/me?api_key=secret123", { authorization: "Bearer sk-live-xyz" }),
      ),
    );

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("sk-live-xyz");
    expect(serialized).not.toContain("secret123");
    expect(serialized).toContain("redacted");
    // The header name survives — that a token was sent is the diagnostic value.
    expect(serialized).toContain("authorization");
  });

  test("a successful response carries status, timing and headers", () => {
    const events = withNetwork(true, () =>
      recordCdpEvent({
        method: "Network.responseReceived",
        params: {
          requestId: "42.1",
          response: {
            status: 201,
            statusText: "Created",
            url: "https://api.test/todos",
            mimeType: "application/json",
            timing: { receiveHeadersEnd: 38.4 },
            headers: { "content-type": "application/json" },
          },
        },
      }),
    );

    expect(events[0]).toMatchObject({ type: "network.response", level: "debug" });
    expect(events[0]?.data).toMatchObject({ status: 201, ms: 38, mimeType: "application/json" });
  });

  // Turning the option off is for noise, and must not cost error detection.
  test("an opt-out silences ordinary traffic but never failures", () => {
    const quiet = withNetwork(false, () => {
      recordCdpEvent(request("https://api.test/ok"));
      recordCdpEvent({
        method: "Network.responseReceived",
        params: { response: { status: 200, url: "https://api.test/ok" } },
      });
    });
    expect(quiet).toHaveLength(0);

    const failures = withNetwork(false, () =>
      recordCdpEvent({
        method: "Network.responseReceived",
        params: { response: { status: 500, url: "https://api.test/boom" } },
      }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ level: "error" });
  });
});
