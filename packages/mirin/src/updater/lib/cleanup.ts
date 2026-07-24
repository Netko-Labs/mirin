import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UPDATER_PROCESS_SESSION } from "./transaction.ts";

const LEGACY_GENERATION_DIRECTORY = /^generation-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;
const OWNED_GENERATION_DIRECTORY =
  /^generation-([1-9]\d*)-([a-f0-9]{32})-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;

interface PruneGenerationOptions {
  currentPid?: number;
  currentSession?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export function removePathBestEffort(path: string, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    // Cleanup must not mask the updater operation that made the path disposable.
  }
}

export function pruneGenerationDirectories(
  updatesDir: string,
  options: PruneGenerationOptions = {},
): void {
  let entries: string[];
  try {
    entries = readdirSync(updatesDir);
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
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    } catch {
      continue;
    }
    removePathBestEffort(path, true);
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
