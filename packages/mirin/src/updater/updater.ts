/**
 * mirin/updater — the `app.updater` API (runs in the Bun Worker).
 *
 * Reads the app's `Resources/version.json` (embedded by `mirin build` when
 * `release` is set), polls `{baseUrl}/{prefix}-update.json`, and when a different
 * version is published downloads it, verifies its SHA-256, then swaps the whole
 * `.app` and relaunches. Updates prefer a small **delta patch** (bsdiff) from the
 * currently-installed version and fall back to the full bundle whenever a patch
 * isn't usable.
 *
 * A signed/notarized `.app` cannot be modified in place without breaking its
 * signature, so the whole bundle is always replaced. Updates run only in a
 * packaged app with `release` set; in `mirin dev` the updater is idle.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { loadCodec } from "../codec.ts";
import { runtime } from "../runtime.ts";
import { applyUpdateAndRelaunch } from "./lib/apply.ts";
import { verifyArchiveLayout } from "./lib/archive.ts";
import { downloadVerifiedArtifact, verifyFileSha256 } from "./lib/integrity.ts";
import { parseManifest } from "./lib/manifest.ts";
import { IS_LINUX, IS_MAC, IS_WINDOWS, platformName } from "./lib/platform.ts";
import { verifyManifestSignature } from "./lib/signature.ts";
import {
  artifactUrl,
  assertTrustedUpdateUrl,
  isLoopbackUpdateUrl,
  trustedBaseUrl,
} from "./lib/urls.ts";
import type {
  Listener,
  Manifest,
  UpdateInfo,
  UpdateProgress,
  UpdaterEvents,
  UpdaterStatus,
  VersionInfo,
} from "./types.ts";

export class Updater {
  #listeners = new Map<keyof UpdaterEvents, Set<Listener<unknown>>>();
  #status: UpdaterStatus = "idle";
  #info: VersionInfo | null | undefined;
  #manifest: Manifest | null = null;
  #staged: string | null = null;
  #autoCheck: ReturnType<typeof setInterval> | undefined;
  #downloadInFlight: Promise<void> | null = null;

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
  /** Whether updates are configured (packaged build with `release` set). */
  get enabled(): boolean {
    return this.#version() != null;
  }

  /** Fetch the channel manifest; report an available update or `null`. Never throws. */
  async checkForUpdate(): Promise<UpdateInfo | null> {
    const v = this.#version();
    if (!v) return null;
    this.#setStatus("checking");
    try {
      const base = this.#baseUrl(v);
      const manifestName = `${this.#prefix()}-update.json`;
      const url = `${base}/${manifestName}?t=${Date.now()}`;
      const res = await fetch(url, { redirect: "follow" });
      assertTrustedUpdateUrl(res.url);
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const manifestText = await res.text();
      // Authenticity before trust: when a release public key is pinned, a valid
      // detached Ed25519 signature over the exact manifest bytes is required
      // before any field of the manifest is believed.
      await this.#verifyManifestSignature(base, manifestName, manifestText, v);
      const m = parseManifest(JSON.parse(manifestText), {
        channel: v.channel,
        platform: platformName(),
        arch: process.arch,
      });
      if (!m.version || m.version === v.version) {
        this.#manifest = null;
        this.#setStatus("idle");
        return null;
      }
      this.#manifest = m;
      const info: UpdateInfo = {
        version: m.version,
        currentVersion: v.version,
        channel: v.channel,
        body: m.body,
      };
      this.#setStatus("update-available");
      this.#emit("update-available", info);
      return info;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  /**
   * Download + verify the pending update — a delta patch from the installed
   * version when available, else the full bundle. Emits `progress`. Concurrent
   * callers (e.g. a manual click racing the auto-check) share one download
   * instead of clobbering the shared work dir and staged path.
   */
  async download(onProgress?: (p: UpdateProgress) => void): Promise<void> {
    if (this.#downloadInFlight) return this.#downloadInFlight;
    this.#downloadInFlight = this.#doDownload(onProgress).finally(() => {
      this.#downloadInFlight = null;
    });
    return this.#downloadInFlight;
  }

  async #doDownload(onProgress?: (p: UpdateProgress) => void): Promise<void> {
    const v = this.#version();
    const m = this.#manifest;
    if (!v || !m) throw new Error("no update to download — call checkForUpdate() first");
    this.#setStatus("downloading");
    try {
      const codec = loadCodec(this.#corePath());
      const support = this.#supportDir(v);
      const tarsDir = join(support, "tars");
      const work = join(support, "updates");
      mkdirSync(tarsDir, { recursive: true });
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });

      const base = this.#baseUrl(v);
      const newTar = join(work, "new.tar");
      const cachedTar = join(tarsDir, `${v.version}.tar`);
      const patch = m.patches?.find((p) => p.fromVersion === v.version);
      const reportProgress = (progress: UpdateProgress) => {
        this.#emit("progress", progress);
        onProgress?.(progress);
      };

      let ok = false;
      if (patch && existsSync(cachedTar)) {
        try {
          const patchZst = join(work, "patch.zst");
          await downloadVerifiedArtifact({
            url: artifactUrl(base, patch.url),
            destination: patchZst,
            sha256: patch.sha256,
            size: patch.size,
            onProgress: reportProgress,
          });
          const patchRaw = join(work, "patch.bin");
          codec.decompress(patchZst, patchRaw);
          codec.patch(cachedTar, patchRaw, newTar); // bspatch
          await verifyFileSha256(newTar, m.tarHash, "reconstructed bundle hash mismatch");
          ok = true;
        } catch {
          ok = false; // delta failed → full bundle
        }
      }
      if (!ok) {
        const bundleZst = join(work, "bundle.tar.zst");
        await downloadVerifiedArtifact({
          url: artifactUrl(base, m.bundle.url),
          destination: bundleZst,
          sha256: m.bundle.sha256,
          size: m.bundle.size,
          onProgress: reportProgress,
        });
        codec.decompress(bundleZst, newTar);
        await verifyFileSha256(newTar, m.tarHash, "reconstructed bundle hash mismatch");
      }

      // Cache the new tar (for the next delta) and extract for swapping.
      const keepTar = join(tarsDir, `${m.version}.tar`);
      rmSync(keepTar, { force: true });
      renameSync(newTar, keepTar);
      await verifyArchiveLayout(keepTar, IS_WINDOWS || IS_LINUX ? v.name : `${v.name}.app`);
      await $`tar -xf ${keepTar} -C ${work}`.quiet();
      // The packaged unit: a flat app folder on Windows/Linux, an `.app` on macOS.
      const staged = join(work, IS_WINDOWS || IS_LINUX ? v.name : `${v.name}.app`);
      if (!existsSync(staged)) throw new Error(`extracted bundle not found at ${staged}`);

      // codesign is macOS-only; on Windows/Linux the Ed25519 manifest signature
      // (when configured) is the authenticity gate. Pin the Team ID when the app
      // ships one, so an update signed by a *different* Developer ID is rejected
      // rather than accepted merely for being validly signed.
      if (IS_MAC) {
        const requirement = v.teamId
          ? ["-R", `anchor apple generic and certificate leaf[subject.OU] = ${v.teamId}`]
          : [];
        const verify = await $`codesign --verify --deep --strict ${requirement} ${staged}`
          .quiet()
          .nothrow();
        if (verify.exitCode !== 0)
          throw new Error("codesign verification failed on the downloaded update");
      }

      // Keep only the newest cached tar.
      for (const f of readdirSync(tarsDir)) {
        if (f !== `${m.version}.tar`) rmSync(join(tarsDir, f), { force: true });
      }

      this.#staged = staged;
      this.#setStatus("update-available");
    } catch (err) {
      this.#fail(err);
      throw err;
    }
  }

  /** Swap the running `.app` with the downloaded bundle and relaunch. */
  async applyAndRelaunch(): Promise<void> {
    const v = this.#version();
    if (!v || !this.#staged) throw new Error("no staged update — call download() first");
    this.#setStatus("applying");
    try {
      await applyUpdateAndRelaunch({
        resourcesDir: this.#resourcesDir()!,
        staged: this.#staged,
        version: v,
      });
      this.#setStatus("complete");
      runtime().core.quit();
    } catch (err) {
      this.#fail(err);
      throw err;
    }
  }

  /** Poll for updates every `intervalMs`. Returns a stop function. */
  startAutoCheck(intervalMs = 6 * 60 * 60 * 1000): () => void {
    this.stopAutoCheck();
    void this.checkForUpdate();
    this.#autoCheck = setInterval(() => void this.checkForUpdate(), intervalMs);
    return () => this.stopAutoCheck();
  }

  stopAutoCheck(): void {
    if (this.#autoCheck) clearInterval(this.#autoCheck);
    this.#autoCheck = undefined;
  }

  // ---- internals ----

  /** Fetch and verify the detached manifest signature when a public key is
   *  pinned. No-op when the app ships without a `publicKey` (native pinning is
   *  then the sole authenticity layer). Throws on a missing/invalid signature. */
  async #verifyManifestSignature(
    base: string,
    manifestName: string,
    manifestText: string,
    v: VersionInfo,
  ): Promise<void> {
    if (!v.publicKey) return;
    const sigUrl = `${base}/${manifestName}.sig?t=${Date.now()}`;
    const sigRes = await fetch(sigUrl, { redirect: "follow" });
    assertTrustedUpdateUrl(sigRes.url);
    if (!sigRes.ok) throw new Error("update manifest signature missing");
    const signature = (await sigRes.text()).trim();
    const ok = verifyManifestSignature(
      new TextEncoder().encode(manifestText),
      signature,
      v.publicKey,
    );
    if (!ok) throw new Error("update manifest signature verification failed");
  }

  #version(): VersionInfo | null {
    if (this.#info !== undefined) return this.#info;
    const dir = this.#resourcesDir();
    const path = dir ? join(dir, "version.json") : undefined;
    if (path && existsSync(path)) {
      try {
        this.#info = JSON.parse(readFileSync(path, "utf8")) as VersionInfo;
      } catch {
        this.#info = null;
      }
    } else {
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
    const p = runtime().corePath;
    if (!p) throw new Error("libmirin_core path unavailable");
    return p;
  }

  #prefix(): string {
    return `${this.#version()!.channel}-${platformName()}-${process.arch}`;
  }

  /** The release host to poll. `MIRIN_UPDATE_BASE_URL` may override the embedded
   *  `baseUrl` only when it points at loopback — that is local end-to-end
   *  testing. A packaged build must never let ambient env redirect updates to an
   *  arbitrary remote host. */
  #baseUrl(v: VersionInfo): string {
    const override = process.env.MIRIN_UPDATE_BASE_URL;
    if (override && isLoopbackUpdateUrl(override)) return trustedBaseUrl(override);
    return trustedBaseUrl(v.baseUrl);
  }

  #supportDir(v: VersionInfo): string {
    if (IS_WINDOWS) {
      const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
      return join(base, v.identifier, v.channel);
    }
    if (IS_LINUX) {
      // XDG base dir spec: $XDG_DATA_HOME, defaulting to ~/.local/share.
      const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
      return join(base, v.identifier, v.channel);
    }
    return join(homedir(), "Library", "Application Support", v.identifier, v.channel);
  }

  #setStatus(status: UpdaterStatus): void {
    this.#status = status;
    this.#emit("status", { status });
  }

  #fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#status = "error";
    this.#emit("status", { status: "error" });
    this.#emit("error", { message });
  }

  #emit<K extends keyof UpdaterEvents>(type: K, payload: UpdaterEvents[K]): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(payload);
    try {
      runtime().rpc.broadcast(`mirin:updater:${type}`, payload);
    } catch {
      // detached / rpc not up — ignore
    }
  }
}

export const updater = new Updater();
