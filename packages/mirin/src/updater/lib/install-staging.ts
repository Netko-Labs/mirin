import { cpSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { VersionInfo } from "../types.ts";
import { type UpdatePlatform, validateStagedBundle } from "./staged.ts";

const OWNED_INSTALL_SIBLING_SUFFIX =
  /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  isProcessAlive?: (pid: number) => boolean;
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
    `.${basename(runningApp)}.mirin-new-${process.pid}-${crypto.randomUUID()}`,
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
 * preserve every matching sibling until that helper is gone.
 */
export function pruneInstallSiblingDirectories(options: PruneInstallSiblingOptions): void {
  const runningApp = runningAppPath(options.resourcesDir, options.platform);
  const parent = dirname(runningApp);
  const prefix = `.${basename(runningApp)}.mirin-new-`;
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const owner = OWNED_INSTALL_SIBLING_SUFFIX.exec(entry.slice(prefix.length));
    if (!owner) continue;
    const ownerPid = Number(owner[1]);
    if (!Number.isSafeInteger(ownerPid)) continue;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    if (isProcessAlive(ownerPid) || options.hasLiveHelper) continue;

    const candidate = join(parent, entry);
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      rmSync(candidate, { recursive: true, force: true });
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
