import { rmSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_UPDATE_HANDOFF_AGE_MS } from "../../update-handoff.ts";
import { UPDATER_PROCESS_SESSION } from "./transaction.ts";

const LEGACY_GENERATION_DIRECTORY = /^generation-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;
const OWNED_GENERATION_DIRECTORY =
  /^generation-([1-9]\d*)-([a-f0-9]{32})-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;
export const APPLY_HELPER_PID_FILE = ".apply-helper.pid";
export const APPLY_HELPER_ARMED_FILE = ".apply-helper-armed";
export const MAX_APPLY_HELPER_AGE_MS = MAX_UPDATE_HANDOFF_AGE_MS;

interface PruneGenerationOptions {
  currentPid?: number;
  currentSession?: string;
  isProcessAlive?: (pid: number) => boolean;
  nowMs?: number;
}

interface LiveApplyHelperOptions {
  currentPid?: number;
  isProcessAlive?: (pid: number) => boolean;
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
  try {
    entries = await readdir(updatesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const owner = OWNED_GENERATION_DIRECTORY.exec(entry);
    if (!owner && !LEGACY_GENERATION_DIRECTORY.test(entry)) continue;
    if (owner) {
      const pid = Number(owner[1]);
      const session = owner[2];
      const currentPid = options.currentPid ?? process.pid;
      const currentSession = options.currentSession ?? UPDATER_PROCESS_SESSION;
      if (pid === currentPid && session === currentSession) continue;
      const isProcessAlive = options.isProcessAlive ?? processIsAlive;
      if (pid !== currentPid && isProcessAlive(pid)) continue;
    }
    const path = join(updatesDir, entry);
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    } catch {
      continue;
    }
    const helperPid = await applyHelperPid(path, options.nowMs ?? Date.now());
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    if (
      helperPid !== undefined &&
      helperPid !== (options.currentPid ?? process.pid) &&
      isProcessAlive(helperPid)
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
    const helperPid = await applyHelperPid(path, options.nowMs ?? Date.now());
    if (
      helperPid !== undefined &&
      helperPid !== (options.currentPid ?? process.pid) &&
      (options.isProcessAlive ?? processIsAlive)(helperPid)
    ) {
      return true;
    }
  }
  return false;
}

async function applyHelperPid(workDir: string, nowMs: number): Promise<number | undefined> {
  try {
    const marker = join(workDir, APPLY_HELPER_PID_FILE);
    const metadata = await lstat(marker);
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > 32 ||
      !Number.isFinite(nowMs) ||
      Math.abs(nowMs - metadata.mtimeMs) > MAX_APPLY_HELPER_AGE_MS
    ) {
      return undefined;
    }
    const value = await readFile(marker, "utf8");
    if (!/^[1-9]\d*$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? pid : undefined;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
