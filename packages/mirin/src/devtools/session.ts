/**
 * The dev-session protocol: the on-disk contract under `.mirin/dev/<session>/`
 * between `mirin dev`, the Worker, and external tools. Free of FFI/runtime
 * imports so the CLI can use it without loading libmirin_core. Exactly one
 * process writes each file, so no locking is required.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asArray, asEnum, asNumber, asRecord, asString, parseJsonRecord } from "./lib/parse.ts";
import type { DevEvent, DevEventLevel, DevEventSource, InspectorEndpoint } from "./types.ts";

// Re-exported so protocol consumers get the record types with the readers.
export type {
  DevEvent,
  DevEventLevel,
  DevEventQuery,
  DevEventSource,
  InspectorEndpoint,
} from "./types.ts";

/** Env var carrying the active session dir into the app process. */
export const DEV_SESSION_ENV = "MIRIN_DEV_SESSION";

/** Env var carrying CEF's remote-debugging port. Read by the host (which passes it
 *  to the native core) and by the Worker's CDP client. */
export const DEV_CDP_PORT_ENV = "MIRIN_CDP_PORT";

export const SESSION_FILE = "session.json";
export const INSPECTOR_FILE = "inspector.json";
export const EVENTS_FILE = "events.jsonl";
export const EXIT_FILE = "exit.json";
export const CURRENT_FILE = "current.json";
export const SCREENSHOT_DIR = "screenshots";

/** One step of the CLI's work, for agents diagnosing a failed startup. */
export interface SessionPhase {
  /** e.g. `compile`, `bundle`, `vite`, `launch`. */
  name: string;
  status: "start" | "ok" | "fail";
  ts: number;
  /** Wall-clock duration, on terminal statuses. */
  ms?: number;
  detail?: string;
}

/** `session.json` — written by the CLI, read by anyone. */
export interface SessionInfo {
  version: 1;
  id: string;
  app: { name: string; id: string; version?: string };
  projectDir: string;
  startedAt: number;
  /** True for `mirin dev` / `mirin check`; false for a packaged build. */
  dev: boolean;
  devUrl?: string;
  pid?: number;
  phases: SessionPhase[];
}

/** `exit.json` — the post-mortem written when the app process ends. */
export interface SessionExit {
  version: 1;
  exitedAt: number;
  code: number | null;
  signal?: string;
  errorCount: number;
  /** The last few events before exit, so a reader needs only this file. */
  tail: DevEvent[];
}

export interface SessionPaths {
  dir: string;
  session: string;
  inspector: string;
  events: string;
  exit: string;
  screenshots: string;
}

export function devRoot(projectDir: string): string {
  return join(projectDir, ".mirin", "dev");
}

export function sessionPaths(dir: string): SessionPaths {
  return {
    dir,
    session: join(dir, SESSION_FILE),
    inspector: join(dir, INSPECTOR_FILE),
    events: join(dir, EVENTS_FILE),
    exit: join(dir, EXIT_FILE),
    screenshots: join(dir, SCREENSHOT_DIR),
  };
}

/** A sortable, collision-free session id, e.g. `20260730-041912-8421`: name order
 *  is start-time order. */
export function newSessionId(now: number, pid: number): string {
  const iso = new Date(now).toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `${stamp}-${pid}`;
}

/** Write JSON via a temp file + rename, so a reader never sees a partial file. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function createSessionDir(projectDir: string, id: string): SessionPaths {
  const paths = sessionPaths(join(devRoot(projectDir), id));
  mkdirSync(paths.screenshots, { recursive: true });
  return paths;
}

export function writeSessionInfo(paths: SessionPaths, info: SessionInfo): void {
  writeJsonAtomic(paths.session, info);
}

export function writeSessionExit(paths: SessionPaths, exit: SessionExit): void {
  writeJsonAtomic(paths.exit, exit);
}

export function writeInspectorEndpoint(paths: SessionPaths, endpoint: InspectorEndpoint): void {
  writeJsonAtomic(paths.inspector, endpoint);
}

/** Point `.mirin/dev/current.json` at `dir`, so tools can find the live session. */
export function writeCurrentSession(projectDir: string, dir: string): void {
  writeJsonAtomic(join(devRoot(projectDir), CURRENT_FILE), { session: dir });
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseJsonRecord(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The session dir `current.json` points at, if it still exists. */
export function readCurrentSession(projectDir: string): string | undefined {
  const record = readJsonRecord(join(devRoot(projectDir), CURRENT_FILE));
  const dir = asString(record?.session);
  return dir !== undefined && existsSync(dir) ? dir : undefined;
}

function parsePhase(value: unknown): SessionPhase | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const name = asString(record.name);
  const status = asEnum(record.status, ["start", "ok", "fail"] as const);
  const ts = asNumber(record.ts);
  if (name === undefined || status === undefined || ts === undefined) return undefined;
  const ms = asNumber(record.ms);
  const detail = asString(record.detail);
  return { name, status, ts, ...(ms !== undefined ? { ms } : {}), ...(detail ? { detail } : {}) };
}

export function parseSessionInfo(value: unknown): SessionInfo | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const app = asRecord(record.app);
  const id = asString(record.id);
  const name = asString(app?.name);
  const appId = asString(app?.id);
  const projectDir = asString(record.projectDir);
  const startedAt = asNumber(record.startedAt);
  if (id === undefined || name === undefined || appId === undefined) return undefined;
  if (projectDir === undefined || startedAt === undefined) return undefined;

  const version = asString(app?.version);
  const devUrl = asString(record.devUrl);
  const pid = asNumber(record.pid);
  return {
    version: 1,
    id,
    app: { name, id: appId, ...(version !== undefined ? { version } : {}) },
    projectDir,
    startedAt,
    dev: record.dev === true,
    ...(devUrl !== undefined ? { devUrl } : {}),
    ...(pid !== undefined ? { pid } : {}),
    phases: (asArray(record.phases) ?? []).flatMap((entry) => parsePhase(entry) ?? []),
  };
}

export function readSessionInfo(paths: SessionPaths): SessionInfo | undefined {
  return parseSessionInfo(readJsonRecord(paths.session));
}

export function parseInspectorEndpoint(value: unknown): InspectorEndpoint | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const port = asNumber(record.port);
  const token = asString(record.token);
  const pid = asNumber(record.pid);
  const startedAt = asNumber(record.startedAt);
  if (port === undefined || token === undefined) return undefined;
  if (pid === undefined || startedAt === undefined) return undefined;
  const cdpPort = asNumber(record.cdpPort);
  return {
    version: 1,
    port,
    token,
    pid,
    startedAt,
    ...(cdpPort !== undefined ? { cdpPort } : {}),
  };
}

export function readInspectorEndpoint(paths: SessionPaths): InspectorEndpoint | undefined {
  return parseInspectorEndpoint(readJsonRecord(paths.inspector));
}

const SOURCES: readonly DevEventSource[] = ["main", "renderer", "native", "rpc", "app"];
const LEVELS: readonly DevEventLevel[] = ["debug", "info", "warn", "error"];

/** Parse one `events.jsonl` line. Returns undefined for a malformed record. */
export function parseDevEvent(value: unknown): DevEvent | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const seq = asNumber(record.seq);
  const ts = asNumber(record.ts);
  const src = asEnum(record.src, SOURCES);
  const level = asEnum(record.level, LEVELS);
  const type = asString(record.type);
  if (seq === undefined || ts === undefined) return undefined;
  if (src === undefined || level === undefined || type === undefined) return undefined;
  const window = asNumber(record.window);
  const data = asRecord(record.data);
  return {
    seq,
    ts,
    src,
    level,
    type,
    msg: asString(record.msg) ?? "",
    ...(window !== undefined ? { window } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Read `events.jsonl` back into records. A partially written trailing line (the
 *  app is still running) is skipped, not treated as corruption. */
export function readEventsFile(path: string): DevEvent[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parsed = parseDevEvent(parseJsonRecord(line));
      return parsed !== undefined ? [parsed] : [];
    });
}
