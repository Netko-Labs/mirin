import { cpSync, lstatSync, rmSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_UPDATE_HANDOFF_AGE_MS } from "../../update-handoff.ts";
import type { VersionInfo } from "../types.ts";
import { type UpdatePlatform, validateStagedBundle } from "./staged.ts";
import { UPDATER_PROCESS_SESSION } from "./transaction.ts";

const OWNED_INSTALL_SIBLING_SUFFIX =
  /^([1-9]\d*)-([a-f0-9]{32})-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_INSTALL_SIBLING_SUFFIX =
  /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_INSTALL_SIBLING_AGE_MS = MAX_UPDATE_HANDOFF_AGE_MS;

interface PrepareInstallSiblingOptions {
  resourcesDir: string;
  downloadedStage: string;
  platform: UpdatePlatform;
  installed: VersionInfo;
  expectedVersion: string;
  verifyMacIdentity?: (installedApp: string, stagedApp: string) => Promise<void>;
}

interface PruneInstallSiblingOptions {
  resourcesDir: string;
  platform: UpdatePlatform;
  hasLiveHelper?: boolean;
  currentPid?: number;
  currentSession?: string;
  isProcessAlive?: (pid: number) => boolean;
  nowMs?: number;
}

/**
 * Copy the validated download onto the install filesystem before terminal
 * handoff, then revalidate the complete copy. The helper only performs sibling
 * renames, never a cross-volume move into the canonical app path.
 */
export async function prepareInstallSibling(
  options: PrepareInstallSiblingOptions,
): Promise<string> {
  const runningApp = runningAppPath(options.resourcesDir, options.platform);
  const parent = dirname(runningApp);
  if (!lstatSync(parent).isDirectory()) {
    throw new Error("installed app parent is not a directory");
  }
  const staged = join(
    parent,
    `.${basename(runningApp)}.mirin-new-${process.pid}-${UPDATER_PROCESS_SESSION}-${Date.now()}-${crypto.randomUUID()}`,
  );
  try {
    cpSync(options.downloadedStage, staged, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    validateStagedBundle({
      staged,
      extractionRoot: parent,
      platform: options.platform,
      installed: options.installed,
      expectedVersion: options.expectedVersion,
    });
    if (options.platform === "darwin") {
      const verify = options.verifyMacIdentity;
      if (!verify) throw new Error("macOS install staging requires code identity verification");
      await verify(runningApp, staged);
    }
    return staged;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Remove strict install-side staging siblings left by dead updater owners.
 * A live apply helper can own one after its app parent exits, so conservatively
 * preserve matching siblings within its bounded ownership lease.
 */
export async function pruneInstallSiblingDirectories(
  options: PruneInstallSiblingOptions,
): Promise<void> {
  const runningApp = runningAppPath(options.resourcesDir, options.platform);
  const parent = dirname(runningApp);
  const prefix = `.${basename(runningApp)}.mirin-new-`;
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    const owner = OWNED_INSTALL_SIBLING_SUFFIX.exec(suffix);
    const legacyOwner = owner ? null : LEGACY_INSTALL_SIBLING_SUFFIX.exec(suffix);
    if (!owner && !legacyOwner) continue;
    const ownerPidText = owner?.[1] ?? legacyOwner?.[1];
    if (!ownerPidText) continue;
    const ownerPid = Number(ownerPidText);
    if (!Number.isSafeInteger(ownerPid)) continue;

    const candidate = join(parent, entry);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      const currentPid = options.currentPid ?? process.pid;
      const currentSession = options.currentSession ?? UPDATER_PROCESS_SESSION;
      const createdAtMs = owner ? Number(owner[3]) : metadata.mtimeMs;
      const nowMs = options.nowMs ?? Date.now();
      const withinLease =
        Number.isFinite(nowMs) &&
        Number.isFinite(createdAtMs) &&
        Math.abs(nowMs - createdAtMs) <= MAX_INSTALL_SIBLING_AGE_MS;
      const sameSession = ownerPid === currentPid && owner?.[2] === currentSession;
      const liveLeasedOwner =
        ownerPid !== currentPid &&
        withinLease &&
        (options.isProcessAlive ?? processIsAlive)(ownerPid);
      if (options.hasLiveHelper || sameSession || liveLeasedOwner) continue;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Startup cleanup is best-effort and must not prevent app launch.
    }
  }
}

function runningAppPath(resourcesDir: string, platform: UpdatePlatform): string {
  return platform === "darwin" ? join(resourcesDir, "..", "..") : join(resourcesDir, "..");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
