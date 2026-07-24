import { rmSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_UPDATE_HANDOFF_AGE_MS } from "../../update-handoff.ts";
import {
  parseProcessIdentity,
  processIdentityMatches,
  type UpdateProcessIdentity,
} from "../../update-process.ts";
import { UPDATER_PROCESS_SESSION } from "./transaction.ts";

const LEGACY_GENERATION_DIRECTORY = /^generation-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;
const OWNED_GENERATION_DIRECTORY =
  /^generation-([1-9]\d*)-([a-f0-9]{32})-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;
export const APPLY_HELPER_PID_FILE = ".apply-helper.pid";
export const APPLY_HELPER_LAUNCH_PID_FILE = ".apply-helper-launch.pid";
export const APPLY_HELPER_ACTIVATED_FILE = ".apply-helper-activated";
export const APPLY_HELPER_ARMED_FILE = ".apply-helper-armed";
export const MAX_APPLY_HELPER_AGE_MS = MAX_UPDATE_HANDOFF_AGE_MS;
export const MAX_GENERATION_OWNER_AGE_MS = MAX_UPDATE_HANDOFF_AGE_MS;
export const GENERATION_OWNER_FILE = ".generation-owner";

interface PruneGenerationOptions {
  currentPid?: number;
  currentSession?: string;
  isOwnerAlive?: (identity: UpdateProcessIdentity) => boolean;
  isHelperAlive?: (identity: UpdateProcessIdentity) => boolean;
  nowMs?: number;
}

interface LiveApplyHelperOptions {
  currentPid?: number;
  isProcessAlive?: (identity: UpdateProcessIdentity) => boolean;
  nowMs?: number;
}

export function removePathBestEffort(path: string, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    // Cleanup must not mask the updater operation that made the path disposable.
  }
}

export async function pruneGenerationDirectories(
  updatesDir: string,
  options: PruneGenerationOptions = {},
): Promise<void> {
  let entries: string[];
  const nowMs = options.nowMs ?? Date.now();
  try {
    entries = await readdir(updatesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const owner = OWNED_GENERATION_DIRECTORY.exec(entry);
    if (!owner && !LEGACY_GENERATION_DIRECTORY.test(entry)) continue;
    const path = join(updatesDir, entry);
    let modifiedAtMs: number;
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      modifiedAtMs = metadata.mtimeMs;
    } catch {
      continue;
    }
    if (owner) {
      const pid = Number(owner[1]);
      const session = owner[2];
      const currentPid = options.currentPid ?? process.pid;
      const currentSession = options.currentSession ?? UPDATER_PROCESS_SESSION;
      if (pid === currentPid && session === currentSession) continue;
      const withinLease =
        Number.isFinite(nowMs) &&
        Number.isFinite(modifiedAtMs) &&
        Math.abs(nowMs - modifiedAtMs) <= MAX_GENERATION_OWNER_AGE_MS;
      const identity = await generationOwnerIdentity(path);
      const isOwnerAlive = options.isOwnerAlive ?? processIdentityMatches;
      if (pid !== currentPid && withinLease && identity?.pid === pid && isOwnerAlive(identity)) {
        continue;
      }
    }
    const helper = await applyHelperIdentity(path, nowMs);
    const isProcessAlive = options.isHelperAlive ?? processIdentityMatches;
    if (
      helper !== undefined &&
      helper.pid !== (options.currentPid ?? process.pid) &&
      isProcessAlive(helper)
    ) {
      continue;
    }
    await removePathBestEffortAsync(path);
  }
}

export async function hasLiveApplyHelper(
  updatesDir: string,
  options: LiveApplyHelperOptions = {},
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(updatesDir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!OWNED_GENERATION_DIRECTORY.test(entry) && !LEGACY_GENERATION_DIRECTORY.test(entry)) {
      continue;
    }
    const path = join(updatesDir, entry);
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    } catch {
      continue;
    }
    const helper = await applyHelperIdentity(path, options.nowMs ?? Date.now());
    if (
      helper !== undefined &&
      helper.pid !== (options.currentPid ?? process.pid) &&
      (options.isProcessAlive ?? processIdentityMatches)(helper)
    ) {
      return true;
    }
  }
  return false;
}

async function applyHelperIdentity(
  workDir: string,
  nowMs: number,
): Promise<UpdateProcessIdentity | undefined> {
  try {
    const marker = join(workDir, APPLY_HELPER_PID_FILE);
    const metadata = await lstat(marker);
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > 256 ||
      !Number.isFinite(nowMs) ||
      Math.abs(nowMs - metadata.mtimeMs) > MAX_APPLY_HELPER_AGE_MS
    ) {
      return undefined;
    }
    const value = await readFile(marker, "utf8");
    return parseProcessIdentity(value);
  } catch {
    return undefined;
  }
}

async function generationOwnerIdentity(
  workDir: string,
): Promise<UpdateProcessIdentity | undefined> {
  try {
    const marker = join(workDir, GENERATION_OWNER_FILE);
    const metadata = await lstat(marker);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 256) return undefined;
    return parseProcessIdentity(await readFile(marker, "utf8"));
  } catch {
    return undefined;
  }
}

async function removePathBestEffortAsync(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Startup cleanup is best-effort and must not prevent app launch.
  }
}
