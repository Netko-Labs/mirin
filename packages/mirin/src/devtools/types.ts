/**
 * Public devtools types (docs/agent-devtools.md).
 *
 * One envelope carries every diagnostic signal a mirin app produces, whatever
 * its origin: main-process logs, renderer console output, native lifecycle
 * events, RPC traffic, and app-published events. Consumers (the inspector HTTP
 * surface and the `events.jsonl` stream) only ever see this shape.
 */

/** Where an event came from. */
export type DevEventSource =
  /** The Bun Worker: `logger` calls, uncaught errors, unhandled rejections. */
  | "main"
  /** A webview: console output, uncaught exceptions, navigation, failed loads. */
  | "renderer"
  /** The native core: window lifecycle, menu clicks, shortcuts, dialog results. */
  | "native"
  /** The typed RPC plane: requests, responses, and handler failures. */
  | "rpc"
  /** Published by app code through `devtools.event(...)`. */
  | "app";

export type DevEventLevel = "debug" | "info" | "warn" | "error";

/** A single diagnostic record. `seq` is monotonic within one dev session. */
export interface DevEvent {
  /** Monotonic within a session; the cursor for `/logs?since=`. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  src: DevEventSource;
  level: DevEventLevel;
  /** Dotted discriminator, e.g. `console`, `exception`, `rpc.response`. */
  type: string;
  /** Human-readable one-liner. Always present, may be empty. */
  msg: string;
  /** Originating window id, when the event belongs to one. */
  window?: number;
  /** Type-specific detail. Kept JSON-serializable. */
  data?: Record<string, unknown>;
}

/** A record as published; the sink stamps `seq` and `ts`. */
export interface DevEventInput {
  src: DevEventSource;
  level: DevEventLevel;
  type: string;
  msg: string;
  window?: number;
  data?: Record<string, unknown>;
}

/** What app code passes to `devtools.event(...)` — `src` is always `app`. */
export interface AppDevEvent {
  /** Dotted discriminator of your choosing, e.g. `route.change`. */
  type: string;
  msg?: string;
  /** Defaults to `info`. */
  level?: DevEventLevel;
  window?: number;
  data?: Record<string, unknown>;
}

/** Filters accepted by `/logs` and `devtools.read(...)`. */
export interface DevEventQuery {
  /** Return events with `seq` strictly greater than this. */
  since?: number;
  /** Minimum level, by severity order. */
  level?: DevEventLevel;
  /** Restrict to these sources. */
  src?: DevEventSource[];
  /** Restrict to these window ids. */
  window?: number[];
  /** Restrict to events whose `type` starts with one of these prefixes. */
  type?: string[];
  /** Substring match against `msg`, case-insensitive. */
  contains?: string;
  /** Most recent N matches. Defaults to 200. */
  limit?: number;
}

/** The `inspector.json` written into the session dir once the server binds. */
export interface InspectorEndpoint {
  version: 1;
  /** Loopback port the inspector is listening on. */
  port: number;
  /** Bearer token required on every request. */
  token: string;
  /** Worker pid, so a stale file is recognizable. */
  pid: number;
  startedAt: number;
  /** CEF remote-debugging port, when the CDP bridge is enabled. */
  cdpPort?: number;
}
