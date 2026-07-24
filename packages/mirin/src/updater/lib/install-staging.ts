import { cpSync, lstatSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { VersionInfo } from "../types.ts";
import { type UpdatePlatform, validateStagedBundle } from "./staged.ts";

interface PrepareInstallSiblingOptions {
  resourcesDir: string;
  downloadedStage: string;
  platform: UpdatePlatform;
  installed: VersionInfo;
  expectedVersion: string;
  verifyMacIdentity?: (installedApp: string, stagedApp: string) => Promise<void>;
}

/**
 * Copy the validated download onto the install filesystem before terminal
 * handoff, then revalidate the complete copy. The helper only performs sibling
 * renames, never a cross-volume move into the canonical app path.
 */
export async function prepareInstallSibling(
  options: PrepareInstallSiblingOptions,
): Promise<string> {
  const runningApp =
    options.platform === "darwin"
      ? join(options.resourcesDir, "..", "..")
      : join(options.resourcesDir, "..");
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
