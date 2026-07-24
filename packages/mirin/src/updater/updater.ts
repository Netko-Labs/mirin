import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCodec } from "../codec.ts";
import { runtime } from "../runtime.ts";
import { applyUpdateAndRelaunch } from "./lib/apply.ts";
import { verifyArchiveLayout } from "./lib/archive.ts";
import { pruneGenerationDirectories, removePathBestEffort } from "./lib/cleanup.ts";
import { parseManifestBytes, readBoundedManifestBytes, readBoundedSignature } from "./lib/http.ts";
import { downloadVerifiedArtifact, verifyFileSha256 } from "./lib/integrity.ts";
import { MAX_PATCH_MEMORY_INPUT_BYTES, MAX_TAR_BYTES } from "./lib/limits.ts";
import { parseManifest } from "./lib/manifest.ts";
import { IS_LINUX, IS_MAC, IS_WINDOWS, platformName } from "./lib/platform.ts";
import { isStrictlyNewer } from "./lib/semver.ts";
import { verifyManifestSignature } from "./lib/signature.ts";
import { validateStagedBundle } from "./lib/staged.ts";
import {
  assertDownloadCanStart,
  generationDirectoryName,
  type PendingGeneration,
  runDownloadOperation,
  SingleFlight,
  UpdateTransactionState,
} from "./lib/transaction.ts";
import { artifactUrl, fetchTrustedUpdateUrl, trustedBaseUrl } from "./lib/urls.ts";
import { readVersionJsonFile } from "./lib/version.ts";
import type {
  Listener,
  Manifest,
  UpdateInfo,
  UpdateProgress,
  UpdaterEvents,
  UpdaterStatus,
  VersionInfo,
} from "./types.ts";

class StaleGenerationError extends Error {
  constructor() {
    super("update generation became stale during download");
  }
}

interface PendingManifest extends PendingGeneration {
  manifest: Manifest;
}

export class Updater {
  #listeners = new Map<keyof UpdaterEvents, Set<Listener<unknown>>>();
  #status: UpdaterStatus = "idle";
  #info: VersionInfo | null | undefined;
  #pendingManifest: PendingManifest | null = null;
  #transactions = new UpdateTransactionState();
  #checks = new SingleFlight<UpdateInfo | null>();
  #autoCheck: ReturnType<typeof setInterval> | undefined;

  on<K extends keyof UpdaterEvents>(type: K, listener: Listener<UpdaterEvents[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as Listener<unknown>);
    return () => {
      set.delete(listener as Listener<unknown>);
    };
  }

  get status(): UpdaterStatus {
    return this.#status;
  }

  get currentVersion(): string {
    return this.#version()?.version ?? "0.0.0";
  }

  get channel(): string {
    return this.#version()?.channel ?? "stable";
  }

  /** Whether updates are configured with valid packaged metadata. */
  get enabled(): boolean {
    return this.#version() != null;
  }

  /** Fetch the channel manifest; report a strictly newer update or `null`. Never throws. */
  checkForUpdate(): Promise<UpdateInfo | null> {
    if (
      this.#transactions.isApplying ||
      this.#transactions.isDownloading ||
      this.#transactions.staged
    ) {
      return Promise.resolve(null);
    }
    return this.#checks.run(() => this.#performCheck());
  }

  async #performCheck(): Promise<UpdateInfo | null> {
    const version = this.#version();
    if (!version) return null;

    let generation: number | undefined;
    try {
      generation = this.#transactions.beginCheck();
      this.#pendingManifest = null;
      this.#setStatus("checking");

      const base = this.#baseUrl(version);
      const manifestUrl = `${base}/${this.#prefix(version)}-update.json`;
      const cacheBust = `t=${Date.now()}`;
      const [response, signatureResponse] = await Promise.all([
        fetchTrustedUpdateUrl(`${manifestUrl}?${cacheBust}`),
        fetchTrustedUpdateUrl(`${manifestUrl}.sig?${cacheBust}`),
      ]);
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      if (!signatureResponse.ok) {
        throw new Error(`manifest signature ${signatureResponse.status}`);
      }
      const manifestBytes = await readBoundedManifestBytes(response);
      verifyManifestSignature(
        manifestBytes,
        await readBoundedSignature(signatureResponse),
        version.publicKey,
      );
      const manifest = parseManifest(parseManifestBytes(manifestBytes), {
        channel: version.channel,
        platform: platformName(),
        arch: process.arch,
      });
      if (!isStrictlyNewer(manifest.version, version.version)) {
        this.#setStatus("idle");
        return null;
      }

      const pending = this.#transactions.commitCheck(
        generation,
        manifest.version,
        manifest.tarHash,
      );
      if (!pending) {
        this.#setStatus("idle");
        return null;
      }
      this.#pendingManifest = { ...pending, manifest };
      const info: UpdateInfo = {
        version: manifest.version,
        currentVersion: version.version,
        channel: version.channel,
        body: manifest.body,
      };
      this.#setStatus("update-available");
      this.#emit("update-available", info);
      return info;
    } catch (error) {
      if (generation !== undefined) {
        const staged = this.#transactions.invalidate();
        this.#pendingManifest = null;
        if (staged) removePathBestEffort(staged.workDir, true);
      }
      this.#fail(error);
      return null;
    }
  }

  /** Download, bound, verify, extract, and structurally validate the pending update. */
  async download(onProgress?: (progress: UpdateProgress) => void): Promise<void> {
    assertDownloadCanStart(this.#transactions, this.#checks.isRunning);
    const snapshot = this.#transactions.beginDownload();
    let workDir: string | undefined;

    await runDownloadOperation({
      state: this.#transactions,
      snapshot,
      operation: async () => {
        const installed = this.#version();
        const pending = this.#pendingManifest;
        if (!installed || !pending || !this.#sameGeneration(snapshot, pending)) {
          throw new Error("pending update metadata is unavailable");
        }

        this.#setStatus("downloading");
        const manifest = pending.manifest;
        const support = supportDir(installed);
        const tarsDir = join(support, "tars");
        const updatesDir = join(support, "updates");
        workDir = join(updatesDir, generationDirectoryName(snapshot));
        const extractDir = join(workDir, "extract");
        mkdirSync(tarsDir, { recursive: true });
        mkdirSync(updatesDir, { recursive: true });
        rmSync(workDir, { recursive: true, force: true });
        mkdirSync(workDir, { recursive: true });

        const codec = loadCodec(this.#corePath());
        const base = this.#baseUrl(installed);
        const newTar = join(workDir, "new.tar");
        const cachedTar = join(tarsDir, `${installed.version}.tar`);
        const patch = manifest.patches?.find(
          (candidate) => candidate.fromVersion === installed.version,
        );
        const reportProgress = (progress: UpdateProgress): void => {
          this.#emit("progress", progress);
          onProgress?.(progress);
        };

        let reconstructed = false;
        if (patch && existsSync(cachedTar)) {
          try {
            const oldTarSize = statSync(cachedTar).size;
            if (oldTarSize <= 0 || oldTarSize > MAX_TAR_BYTES) {
              throw new Error("cached update tar exceeds the updater limit");
            }
            if (oldTarSize + patch.uncompressedSize > MAX_PATCH_MEMORY_INPUT_BYTES) {
              throw new Error("delta patch inputs exceed the updater memory limit");
            }
            const patchZst = join(workDir, "patch.zst");
            await downloadVerifiedArtifact({
              url: artifactUrl(base, patch.url),
              destination: patchZst,
              sha256: patch.sha256,
              size: patch.size,
              onProgress: reportProgress,
            });
            this.#assertCurrent(snapshot);
            const patchRaw = join(workDir, "patch.bin");
            codec.decompressBounded(patchZst, patchRaw, patch.uncompressedSize);
            if (statSync(patchRaw).size !== patch.uncompressedSize) {
              throw new Error("decompressed patch size mismatch");
            }
            codec.patchBounded(
              cachedTar,
              patchRaw,
              newTar,
              oldTarSize,
              patch.uncompressedSize,
              manifest.tarSize,
            );
            await verifyFileSha256(
              newTar,
              manifest.tarHash,
              "reconstructed bundle hash mismatch",
              manifest.tarSize,
            );
            this.#assertCurrent(snapshot);
            reconstructed = true;
          } catch (error) {
            removePathBestEffort(newTar);
            if (error instanceof StaleGenerationError) throw error;
            this.#assertCurrent(snapshot);
          }
        }

        if (!reconstructed) {
          const bundleZst = join(workDir, "bundle.tar.zst");
          await downloadVerifiedArtifact({
            url: artifactUrl(base, manifest.bundle.url),
            destination: bundleZst,
            sha256: manifest.bundle.sha256,
            size: manifest.bundle.size,
            onProgress: reportProgress,
          });
          this.#assertCurrent(snapshot);
          codec.decompressBounded(bundleZst, newTar, manifest.tarSize);
          await verifyFileSha256(
            newTar,
            manifest.tarHash,
            "reconstructed bundle hash mismatch",
            manifest.tarSize,
          );
          this.#assertCurrent(snapshot);
        }

        const bundleRoot = IS_WINDOWS || IS_LINUX ? installed.name : `${installed.name}.app`;
        await verifyArchiveLayout(newTar, bundleRoot);
        this.#assertCurrent(snapshot);
        mkdirSync(extractDir, { recursive: true });
        await runIgnoredCommand(
          ["tar", IS_LINUX ? "-xpf" : "-xf", newTar, "-C", extractDir],
          "tar extraction failed",
        );
        this.#assertCurrent(snapshot);
        const staged = join(extractDir, bundleRoot);
        validateStagedBundle({
          staged,
          extractionRoot: extractDir,
          platform: platformName(),
          installed,
          expectedVersion: manifest.version,
        });

        if (IS_MAC) {
          const resourcesDir = this.#resourcesDir();
          if (!resourcesDir) throw new Error("installed app path is unavailable");
          await verifyMacCodeIdentity(join(resourcesDir, "..", ".."), staged);
        }
        this.#assertCurrent(snapshot);

        const keepTarName = `${manifest.version}.tar`;
        const keepTar = join(tarsDir, keepTarName);
        removePathBestEffort(keepTar);
        renameSync(newTar, keepTar);
        if (!this.#transactions.completeDownload(snapshot, staged, workDir)) {
          throw new StaleGenerationError();
        }
        pruneTarCacheBestEffort(tarsDir, keepTarName);
        this.#setStatus("update-available");
      },
      onCurrentFailure: (error) => {
        this.#pendingManifest = null;
        this.#fail(error);
      },
      cleanup: () => {
        if (workDir) removePathBestEffort(workDir, true);
      },
    });
  }

  /** Launch the platform swap helper, then quit only after launch was accepted. */
  async applyAndRelaunch(): Promise<void> {
    if (this.#checks.isRunning) {
      throw new Error("cannot apply while an update check is in progress");
    }
    const installed = this.#version();
    const resourcesDir = this.#resourcesDir();
    const staged = this.#transactions.beginApply();
    if (!installed || !resourcesDir) {
      this.#transactions.finishApply(false);
      this.#pendingManifest = null;
      removePathBestEffort(staged.workDir, true);
      throw new Error("installed update metadata is unavailable");
    }

    this.#setStatus("applying");
    try {
      await applyUpdateAndRelaunch({
        resourcesDir,
        staged: staged.staged,
        workDir: staged.workDir,
        version: installed,
      });
    } catch (error) {
      this.#transactions.finishApply(false);
      this.#pendingManifest = null;
      removePathBestEffort(staged.workDir, true);
      this.#fail(error);
      throw error;
    }

    this.#transactions.finishApply(true);
    this.stopAutoCheck();
    this.#setStatus("complete");
    runtime().core.quit();
  }

  startAutoCheck(intervalMs = 6 * 60 * 60 * 1000): () => void {
    this.stopAutoCheck();
    if (this.#transactions.isHandedOff) return () => {};
    void this.checkForUpdate();
    this.#autoCheck = setInterval(() => void this.checkForUpdate(), intervalMs);
    return () => this.stopAutoCheck();
  }

  stopAutoCheck(): void {
    if (this.#autoCheck) clearInterval(this.#autoCheck);
    this.#autoCheck = undefined;
  }

  #version(): VersionInfo | null {
    if (this.#info !== undefined) return this.#info;
    const resourcesDir = this.#resourcesDir();
    const path = resourcesDir ? join(resourcesDir, "version.json") : undefined;
    if (!path || !existsSync(path)) {
      this.#info = null;
      return null;
    }
    try {
      this.#info = readVersionJsonFile(path);
    } catch {
      this.#info = null;
    }
    return this.#info;
  }

  #resourcesDir(): string | undefined {
    try {
      return runtime().resourcesDir;
    } catch {
      return undefined;
    }
  }

  #corePath(): string {
    const path = runtime().corePath;
    if (!path) throw new Error("libmirin_core path unavailable");
    return path;
  }

  #prefix(version: VersionInfo): string {
    return `${version.channel}-${platformName()}-${process.arch}`;
  }

  #baseUrl(version: VersionInfo): string {
    return trustedBaseUrl(process.env.MIRIN_UPDATE_BASE_URL ?? version.baseUrl);
  }

  #sameGeneration(left: PendingGeneration, right: PendingGeneration): boolean {
    return (
      left.generation === right.generation &&
      left.version === right.version &&
      left.tarHash === right.tarHash
    );
  }

  #assertCurrent(snapshot: PendingGeneration): void {
    if (!this.#transactions.isCurrent(snapshot)) throw new StaleGenerationError();
  }

  #setStatus(status: UpdaterStatus): void {
    this.#status = status;
    this.#emit("status", { status });
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#status = "error";
    this.#emit("status", { status: "error" });
    this.#emit("error", { message });
  }

  #emit<K extends keyof UpdaterEvents>(type: K, payload: UpdaterEvents[K]): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      try {
        listener(payload);
      } catch {
        // User listeners cannot break updater state transitions or mask failures.
      }
    }
    try {
      runtime().rpc.broadcast(`mirin:updater:${type}`, payload);
    } catch {
      // The runtime may be detached while updater helpers are tested or shutting down.
    }
  }
}

async function runIgnoredCommand(command: string[], errorMessage: string): Promise<void> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${errorMessage} (${exitCode})`);
}

export function stableMacCodeRequirement(codesignOutput: string): string | undefined {
  const requirement = codesignOutput.match(/^(?:#\s*)?designated => (.+)$/m)?.[1]?.trim();
  if (!requirement || requirement.length > 4096) {
    throw new Error("installed app has no bounded designated code requirement");
  }
  // Ad-hoc designated requirements pin the current cdhash and therefore cannot
  // match a rebuilt release. Exact manifest-byte signing is the trust anchor for
  // local ad-hoc update testing; still require the staged bundle to verify below.
  return requirement.startsWith("cdhash ") ? undefined : requirement;
}

async function verifyMacCodeIdentity(installedApp: string, stagedApp: string): Promise<void> {
  const inspect = Bun.spawn(["codesign", "-d", "-r-", installedApp], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await readBoundedText(inspect.stderr, 8192, "codesign inspection output");
  const exitCode = await inspect.exited;
  if (exitCode !== 0) throw new Error(`installed app codesign inspection failed (${exitCode})`);
  const requirement = stableMacCodeRequirement(stderr);
  await runIgnoredCommand(
    [
      "codesign",
      "--verify",
      "--deep",
      "--strict",
      ...(requirement ? [`-R=${requirement}`] : []),
      stagedApp,
    ],
    "downloaded update does not match the installed code identity",
  );
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function pruneTarCacheBestEffort(tarsDir: string, keepFile: string): void {
  let files: string[];
  try {
    files = readdirSync(tarsDir);
  } catch {
    return;
  }
  for (const file of files) {
    if (file !== keepFile) removePathBestEffort(join(tarsDir, file), true);
  }
}

function supportDir(version: VersionInfo): string {
  if (IS_WINDOWS) {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, version.identifier, version.channel);
  }
  if (IS_LINUX) {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, version.identifier, version.channel);
  }
  return join(homedir(), "Library", "Application Support", version.identifier, version.channel);
}

export function initializeUpdater(): void {
  let resourcesDir: string | undefined;
  try {
    resourcesDir = runtime().resourcesDir;
  } catch {
    return;
  }
  if (!resourcesDir) return;

  try {
    const version = readVersionJsonFile(join(resourcesDir, "version.json"));
    pruneGenerationDirectories(join(supportDir(version), "updates"));
  } catch {
    // Invalid or unavailable updater metadata disables startup cleanup.
  }
}

export const updater = new Updater();
