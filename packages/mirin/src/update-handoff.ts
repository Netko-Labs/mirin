import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const HANDOFF_FILE = ".update-handoff.json";
const MAX_HANDOFF_BYTES = 4096;
const MAX_VERSION_BYTES = 16 * 1024;
const HANDOFF_TOKEN = /^[1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const READY_FILE = /^\.update-ready-[1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export const HOST_RUNTIME_PROTOCOL = 1;
export const EXCLUSIVE_UPDATER_CAPABILITY = "exclusive-app-lock-v1";
export const UPDATE_HANDOFF_TOKEN_ENV = "MIRIN_UPDATE_HANDOFF_TOKEN";
export const MAX_UPDATE_HANDOFF_AGE_MS = 24 * 60 * 60 * 1000;

interface UpdateHandoffMarker {
  token: string;
  targetVersion: string;
  ownerPid: number;
  createdAtMs: number;
  helperPid?: number;
}

export interface PreparedUpdateHandoff extends UpdateHandoffMarker {
  markerPath: string;
  readyPath: string;
}

export interface UpdateHandoffDecision {
  blocked: boolean;
  readyPath?: string;
}

/** Keep updater reservations beside the native app lock, outside replaceable app files. */
export function instanceStateDirectory(identifier: string, dev = false): string {
  const safeIdentifier =
    Array.from(identifier)
      .map((character) => (/[\p{L}\p{N}._-]/u.test(character) ? character : "_"))
      .join("") || "app";
  const suffix = dev ? "-dev" : "";
  if (process.platform === "darwin") {
    return join(
      process.env.HOME ?? "/tmp",
      "Library",
      "Application Support",
      "mirin",
      `${safeIdentifier}${suffix}`,
    );
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? process.env.TEMP ?? "C:\\Temp";
    return join(base, "mirin", `${safeIdentifier}${suffix}`);
  }
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "/tmp", ".cache");
  return join(base, "mirin", `${safeIdentifier}${suffix}`);
}

export function prepareUpdateHandoff(
  identifier: string,
  targetVersion: string,
  directory = instanceStateDirectory(identifier),
  createdAtMs = Date.now(),
): PreparedUpdateHandoff {
  if (!validTimestamp(createdAtMs)) throw new Error("invalid updater handoff timestamp");
  mkdirSync(directory, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const markerPath = join(directory, HANDOFF_FILE);
  const readyPath = join(directory, `.update-ready-${token}`);
  removeFileBestEffort(readyPath);
  const marker: UpdateHandoffMarker = {
    token,
    targetVersion,
    ownerPid: process.pid,
    createdAtMs,
  };
  writeFileSync(markerPath, serializeMarker(marker), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { ...marker, markerPath, readyPath };
}

export function activateUpdateHandoff(handoff: PreparedUpdateHandoff, helperPid: number): void {
  if (!validPid(helperPid)) throw new Error("updater helper returned an invalid process id");
  const current = readMarker(handoff.markerPath);
  if (!current || current.token !== handoff.token || current.ownerPid !== process.pid) {
    throw new Error("updater handoff reservation changed before helper activation");
  }
  const temporary = `${handoff.markerPath}.${handoff.token}.tmp`;
  try {
    writeFileSync(temporary, serializeMarker({ ...current, helperPid }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, handoff.markerPath);
  } finally {
    removeFileBestEffort(temporary);
  }
  handoff.helperPid = helperPid;
}

export function abandonUpdateHandoff(handoff: PreparedUpdateHandoff): void {
  const current = readMarker(handoff.markerPath);
  if (current?.token === handoff.token) removeFileBestEffort(handoff.markerPath);
  removeFileBestEffort(handoff.readyPath);
}

/**
 * Decide whether this launch may cross an active updater reservation.
 * Only the staged target version may acquire the native lock while its parent
 * or helper is alive. Stale or expired reservations are removed fail-open to
 * the OS lock so PID reuse cannot permanently reserve an app.
 */
export function inspectUpdateHandoff(
  identifier: string,
  resourcesDir: string,
  dev = false,
  launchToken?: string,
  isProcessAlive: (pid: number) => boolean = processIsAlive,
  directory = instanceStateDirectory(identifier, dev),
  nowMs = Date.now(),
): UpdateHandoffDecision {
  const markerPath = join(directory, HANDOFF_FILE);
  if (!existsSync(markerPath)) return { blocked: false };
  const marker = readMarker(markerPath);
  if (!marker) {
    removeFileBestEffort(markerPath);
    return { blocked: false };
  }

  if (!validTimestamp(nowMs) || Math.abs(nowMs - marker.createdAtMs) > MAX_UPDATE_HANDOFF_AGE_MS) {
    removeFileBestEffort(markerPath);
    removeFileBestEffort(join(directory, `.update-ready-${marker.token}`));
    return { blocked: false };
  }

  const active =
    isProcessAlive(marker.ownerPid) ||
    (marker.helperPid !== undefined && isProcessAlive(marker.helperPid));
  const readyPath = join(directory, `.update-ready-${marker.token}`);
  if (!active) {
    removeFileBestEffort(markerPath);
    removeFileBestEffort(readyPath);
    return { blocked: false };
  }

  return launchToken === marker.token && installedVersion(resourcesDir) === marker.targetVersion
    ? { blocked: false, readyPath }
    : { blocked: true };
}

/** Write the durable receipt consumed by the helper after the app reports ready. */
export function signalUpdateReady(readyPath: string): void {
  if (!READY_FILE.test(basename(readyPath))) {
    throw new Error("invalid updater readiness path");
  }
  const temporary = `${readyPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, String(process.pid), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, readyPath);
  } finally {
    removeFileBestEffort(temporary);
  }
}

function serializeMarker(marker: UpdateHandoffMarker): string {
  return JSON.stringify(marker);
}

function readMarker(path: string): UpdateHandoffMarker | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_HANDOFF_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (
      keys.some(
        (key) => !["token", "targetVersion", "ownerPid", "createdAtMs", "helperPid"].includes(key),
      ) ||
      !HANDOFF_TOKEN.test(String(source.token ?? "")) ||
      typeof source.targetVersion !== "string" ||
      source.targetVersion.length === 0 ||
      source.targetVersion.length > 128 ||
      !validPid(source.ownerPid) ||
      !validTimestamp(source.createdAtMs) ||
      (source.helperPid !== undefined && !validPid(source.helperPid))
    ) {
      return undefined;
    }
    return {
      token: source.token as string,
      targetVersion: source.targetVersion,
      ownerPid: source.ownerPid,
      createdAtMs: source.createdAtMs,
      ...(source.helperPid === undefined ? {} : { helperPid: source.helperPid }),
    } as UpdateHandoffMarker;
  } catch {
    return undefined;
  }
}

function installedVersion(resourcesDir: string): string | undefined {
  try {
    const path = join(resourcesDir, "version.json");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_VERSION_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const version = (value as Record<string, unknown>).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function removeFileBestEffort(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale receipt/marker is recoverable on the next launch.
  }
}
