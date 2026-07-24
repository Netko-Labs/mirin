import { createHash } from "node:crypto";
import { cpSync, lstatSync, rmSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_UPDATE_HANDOFF_AGE_MS } from "../../update-handoff.ts";
import { processIdentity, type UpdateProcessIdentity } from "../../update-process.ts";
import type { VersionInfo } from "../types.ts";
import { type UpdatePlatform, validateStagedBundle } from "./staged.ts";
import { UPDATER_PROCESS_SESSION } from "./transaction.ts";

const IDENTIFIED_INSTALL_SIBLING_SUFFIX =
  /^([1-9]\d*)-([a-f0-9]{32})-([a-f0-9]{64})-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_OWNED_INSTALL_SIBLING_SUFFIX =
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
  syncTree?: (codec: string, staged: string) => Promise<void>;
  ownerIdentity?: UpdateProcessIdentity;
}

interface PruneInstallSiblingOptions {
  resourcesDir: string;
  platform: UpdatePlatform;
  hasLiveHelper?: boolean;
  currentPid?: number;
  currentSession?: string;
  getProcessIdentity?: (pid: number) => UpdateProcessIdentity | undefined;
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
  const codec =
    options.platform === "darwin"
      ? join(runningApp, "Contents", "MacOS", "mirin-codec")
      : join(runningApp, options.platform === "win32" ? "mirin-codec.exe" : "mirin-codec");
  const owner = options.ownerIdentity ?? processIdentity(process.pid, codec);
  if (!owner || owner.pid !== process.pid) {
    throw new Error("could not bind install staging to the current process");
  }
  const ownerTokenHash = createHash("sha256").update(owner.token).digest("hex");
  const staged = join(
    parent,
    `.${basename(runningApp)}.mirin-new-${process.pid}-${UPDATER_PROCESS_SESSION}-${ownerTokenHash}-${Date.now()}-${crypto.randomUUID()}`,
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
    await (options.syncTree ?? syncInstallTree)(codec, staged);
    return staged;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

async function syncInstallTree(codec: string, staged: string): Promise<void> {
  const sync = Bun.spawn([codec, "sync-tree", staged], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await sync.exited) !== 0) {
    throw new Error("could not make the install-filesystem stage durable");
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
    const identifiedOwner = IDENTIFIED_INSTALL_SIBLING_SUFFIX.exec(suffix);
    const legacyOwned = identifiedOwner ? null : LEGACY_OWNED_INSTALL_SIBLING_SUFFIX.exec(suffix);
    const legacyOwner =
      identifiedOwner || legacyOwned ? null : LEGACY_INSTALL_SIBLING_SUFFIX.exec(suffix);
    if (!identifiedOwner && !legacyOwned && !legacyOwner) continue;
    const ownerPidText = identifiedOwner?.[1] ?? legacyOwned?.[1] ?? legacyOwner?.[1];
    if (!ownerPidText) continue;
    const ownerPid = Number(ownerPidText);
    if (!Number.isSafeInteger(ownerPid)) continue;

    const candidate = join(parent, entry);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      const currentPid = options.currentPid ?? process.pid;
      const currentSession = options.currentSession ?? UPDATER_PROCESS_SESSION;
      const createdAtMs = identifiedOwner
        ? Number(identifiedOwner[4])
        : legacyOwned
          ? Number(legacyOwned[3])
          : metadata.mtimeMs;
      const nowMs = options.nowMs ?? Date.now();
      const withinLease =
        Number.isFinite(nowMs) &&
        Number.isFinite(createdAtMs) &&
        Math.abs(nowMs - createdAtMs) <= MAX_INSTALL_SIBLING_AGE_MS;
      const sameSession =
        ownerPid === currentPid &&
        (identifiedOwner?.[2] === currentSession || legacyOwned?.[2] === currentSession);
      const observedIdentity = identifiedOwner
        ? (options.getProcessIdentity ?? processIdentity)(ownerPid)
        : undefined;
      const liveLeasedOwner =
        ownerPid !== currentPid &&
        withinLease &&
        observedIdentity !== undefined &&
        createHash("sha256").update(observedIdentity.token).digest("hex") === identifiedOwner?.[3];
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
