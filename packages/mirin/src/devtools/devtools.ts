/**
 * mirin/devtools — the agent-facing observability facade (docs/agent-devtools.md).
 * Collects every event source into one queryable stream, mirrors it to
 * `.mirin/dev/<session>/events.jsonl`, and serves it over loopback.
 *
 *   devtools.event({ type: "route.change", msg: "/settings" });
 *   devtools.expose("store", () => store.getState());
 */

import type { DevtoolsConfig } from "../config/index.ts";
import { maybeRuntime, onNativeEvent } from "../runtime.ts";
import { CdpBridge } from "./lib/cdp.ts";
import { type InspectorHandle, startInspector } from "./lib/inspector.ts";
import { recordCdpEvent } from "./lib/renderer-taps.ts";
import { cdpRoutes } from "./lib/routes-cdp.ts";
import { installNativeTap, installProcessTaps } from "./lib/taps.ts";
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
  get enabled(): boolean {
    return devtoolsOptions().enabled;
  },

  get session(): SessionPaths | undefined {
    return paths;
  },

  get inspectorUrl(): string | undefined {
    return inspector !== undefined ? `http://127.0.0.1:${inspector.port}` : undefined;
  },

  /** Publish an app-defined event into the stream. Always safe: with devtools
   *  disabled the record lands in the in-memory buffer only. */
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

  /** Publish a named slice of app state under the inspector's `/state`. The getter
   *  runs on each read; one that throws is reported against its own key, not the request. */
  expose(name: string, getter: () => unknown): void {
    exposed.set(name, getter);
  },

  unexpose(name: string): void {
    exposed.delete(name);
  },

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

/** Boot devtools; called from the package entry right after `boot()`. Taps install
 *  here, not at import time; nothing is missed — native events sit in the core's
 *  queue until the Worker's first poll. */
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

  const port = options.cdp ? cdpPort() : undefined;
  // Local binding: route closures must capture a definite bridge, not the
  // reassignable module-level slot.
  const attached = port !== undefined ? startCdpBridge(port) : undefined;
  bridge = attached;

  // `cdpCovers` is read per event, not captured now: CDP attachment completes later.
  teardown.push(
    installNativeTap({
      cdpCovers: (window) =>
        window !== undefined && (attached?.attachedWindows().includes(window) ?? false),
    }),
  );
  teardown.push(installProcessTaps());
  const screenshotDir = paths?.screenshots;

  inspector = startInspector({
    exposed: () => devtools.state(),
    ...(attached !== undefined
      ? {
          extraRoutes: () =>
            cdpRoutes({
              bridge: attached,
              ...(screenshotDir !== undefined ? { screenshotDir } : {}),
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

/** Create the CDP bridge and start attaching. Attachment is async and not awaited:
 *  CEF binds its debugging port after the Worker is already running, and app
 *  startup must not wait on diagnostics. */
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
