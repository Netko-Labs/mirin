/**
 * mirin/devtools — the agent-facing observability facade (docs/agent-devtools.md).
 *
 * A running mirin app produces plenty of signal, but until now all of it was
 * write-only: renderer console output went to stderr, RPC calls went nowhere, and
 * native events were dropped unless a feature happened to subscribe. This module
 * collects every source into one queryable stream, mirrors it to
 * `.mirin/dev/<session>/events.jsonl`, and (with the inspector) serves it over
 * loopback so a tool outside the process can see what the app is doing.
 *
 * App code uses two things:
 *
 *   import { devtools } from "mirinjs";
 *
 *   // publish a domain event into the stream
 *   devtools.event({ type: "route.change", msg: "/settings" });
 *
 *   // publish live state, readable at the inspector's /state
 *   devtools.expose("store", () => store.getState());
 */

import type { DevtoolsConfig } from "../config/index.ts";
import { maybeRuntime, onNativeEvent } from "../runtime.ts";
import { CdpBridge } from "./lib/cdp.ts";
import { type InspectorHandle, startInspector } from "./lib/inspector.ts";
import { cdpRoutes } from "./lib/routes-cdp.ts";
import { installNativeTap, installProcessTaps, recordCdpEvent } from "./lib/taps.ts";
import { devtoolsOptions, resolveDevtoolsOptions, setDevtoolsOptions } from "./options.ts";
import {
  DEV_CDP_PORT_ENV,
  DEV_SESSION_ENV,
  type SessionPaths,
  sessionPaths,
  writeInspectorEndpoint,
} from "./session.ts";
import { record, sink } from "./sink.ts";
import type { AppDevEvent, DevEvent, DevEventQuery, InspectorEndpoint } from "./types.ts";

/** State getters registered through `devtools.expose`. */
const exposed = new Map<string, () => unknown>();

let paths: SessionPaths | undefined;
let inspector: InspectorHandle | undefined;
let bridge: CdpBridge | undefined;
let teardown: (() => void)[] = [];

/** CEF's remote-debugging port for this run, when one was supplied. */
function cdpPort(): number | undefined {
  const value = Number(process.env[DEV_CDP_PORT_ENV] ?? "");
  return Number.isSafeInteger(value) && value >= 1024 && value <= 65535 ? value : undefined;
}

/** A registered getter's current value, or an error marker if it threw. */
function readExposed(getter: () => unknown): unknown {
  try {
    return getter();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export const devtools = {
  /** Whether the devtools subsystem is active in this process. */
  get enabled(): boolean {
    return devtoolsOptions().enabled;
  },

  /** The active session's paths, or undefined when running without a session. */
  get session(): SessionPaths | undefined {
    return paths;
  },

  /** The inspector's loopback URL, or undefined when it is not running. */
  get inspectorUrl(): string | undefined {
    return inspector !== undefined ? `http://127.0.0.1:${inspector.port}` : undefined;
  },

  /**
   * Publish an app-defined event into the stream. Cheap and always safe to call:
   * when devtools are disabled the record lands in the in-memory buffer only.
   */
  event(event: AppDevEvent): void {
    record({
      src: "app",
      level: event.level ?? "info",
      type: event.type,
      msg: event.msg ?? event.type,
      ...(event.window !== undefined ? { window: event.window } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    });
  },

  /**
   * Publish a named slice of app state under the inspector's `/state`. The getter
   * runs on each read, so an agent always sees current values rather than a
   * snapshot from startup. Return JSON-serializable data; a getter that throws is
   * reported as an error against its own key and does not fail the request.
   */
  expose(name: string, getter: () => unknown): void {
    exposed.set(name, getter);
  },

  /** Remove a getter registered with `expose`. */
  unexpose(name: string): void {
    exposed.delete(name);
  },

  /** Every exposed slice, evaluated now. */
  state(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, getter] of exposed) out[name] = readExposed(getter);
    return out;
  },

  /** Query the in-memory event buffer. */
  read(query: DevEventQuery = {}): DevEvent[] {
    return sink.read(query);
  },
};

/**
 * Boot devtools. Called from the package entry immediately after `boot()`, so the
 * run mode and session dir are known.
 *
 * Taps install here rather than at import time (barrels and modules stay
 * side-effect free). Nothing is missed: native events sit in the core's queue
 * until the Worker's first poll, which is at least one interval away.
 */
export function startDevtools(override?: DevtoolsConfig): void {
  const runtime = maybeRuntime();
  const options = resolveDevtoolsOptions(override ?? runtime?.devtools, runtime?.isDev ?? false);
  setDevtoolsOptions(options);
  if (!options.enabled) return;

  sink.resize(options.bufferSize);

  const dir = process.env[DEV_SESSION_ENV];
  if (dir !== undefined && dir.length > 0) {
    paths = sessionPaths(dir);
    if (options.file) sink.openFile(paths.events);
  }

  teardown.push(installNativeTap());
  teardown.push(installProcessTaps());

  const port = options.cdp ? cdpPort() : undefined;
  if (port !== undefined) bridge = startCdpBridge(port);

  inspector = startInspector({
    exposed: () => devtools.state(),
    ...(bridge !== undefined
      ? {
          extraRoutes: () =>
            cdpRoutes({
              bridge: bridge as CdpBridge,
              ...(paths !== undefined ? { screenshotDir: paths.screenshots } : {}),
            }),
        }
      : {}),
  });
  if (inspector !== undefined) {
    publishInspectorEndpoint({
      version: 1,
      port: inspector.port,
      token: inspector.token,
      pid: process.pid,
      startedAt: Date.now(),
      ...(port !== undefined ? { cdpPort: port } : {}),
    });
  }

  record({
    src: "main",
    level: "info",
    type: "devtools.ready",
    msg: "devtools attached",
    data: {
      file: sink.filePath ?? null,
      inspector: inspector !== undefined ? `http://127.0.0.1:${inspector.port}` : null,
      cdpPort: port ?? null,
      bufferSize: options.bufferSize,
    },
  });
}

/**
 * Create the CDP bridge and start attaching.
 *
 * Attachment is asynchronous and deliberately not awaited: CEF binds its debugging
 * port during browser-process init, which happens after the Worker is already
 * running, and nothing about app startup should wait on diagnostics. Each new
 * window triggers a re-scan so its page is attached as soon as it exists.
 */
function startCdpBridge(port: number): CdpBridge {
  const created = new CdpBridge(port, recordCdpEvent);
  teardown.push(onNativeEvent("window.created", () => void created.refresh(true)));

  void created.attachWhenReady().then((attached) => {
    record({
      src: "main",
      level: attached ? "info" : "warn",
      type: attached ? "devtools.cdp-attached" : "devtools.cdp-unavailable",
      msg: attached
        ? `attached to the DevTools protocol on port ${port}`
        : `no webview attached on DevTools port ${port} — screenshots and snapshots are unavailable`,
      data: { port, windows: created.attachedWindows() },
    });
  });

  return created;
}

/** Publish the inspector's endpoint into the session dir. */
export function publishInspectorEndpoint(endpoint: InspectorEndpoint): void {
  if (paths === undefined) return;
  try {
    writeInspectorEndpoint(paths, endpoint);
  } catch (err) {
    record({
      src: "main",
      level: "warn",
      type: "devtools.error",
      msg: `could not publish inspector endpoint: ${err instanceof Error ? err.message : err}`,
    });
  }
}

/** Flush and detach. Called on Worker shutdown paths. */
export function stopDevtools(): void {
  for (const off of teardown) off();
  teardown = [];
  void inspector?.stop();
  inspector = undefined;
  bridge?.close();
  bridge = undefined;
  sink.close();
}
