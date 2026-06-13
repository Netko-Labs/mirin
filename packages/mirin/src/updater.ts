/**
 * mirin/updater — the `app.updater` API (runs in the Bun Worker).
 *
 * Reads the app's own `Resources/version.json` (embedded by `mirin build` when
 * `release` is configured), polls the manifest at `{baseUrl}/{prefix}-update.json`,
 * downloads the full `.app` bundle when a different version is published, verifies
 * its SHA-256, then swaps the whole `.app` and relaunches.
 *
 * A signed/notarized `.app` cannot be modified in place without breaking its
 * signature, so every update replaces the entire bundle. Updates run only in a
 * packaged app with `release` set; in `mirin dev` (no version.json) the updater
 * stays idle and `checkForUpdate()` resolves `null`.
 *
 *   import { app } from "mirinjs";
 *   const info = await app.updater.checkForUpdate();
 *   if (info) { await app.updater.download(p => …); await app.updater.applyAndRelaunch(); }
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { $ } from "bun";
import { runtime } from "./runtime.ts";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "applying"
  | "complete"
  | "error";

/** The running app's embedded identity (Resources/version.json). */
interface VersionInfo {
  version: string;
  channel: string;
  baseUrl: string;
  name: string;
  identifier: string;
}

/** A published release the running app can update to. */
export interface UpdateInfo {
  /** Version being offered. */
  version: string;
  /** The currently-running version. */
  currentVersion: string;
  channel: string;
  /** Artifact filename, relative to baseUrl. */
  url: string;
  sha256: string;
  size?: number;
}

export interface UpdateProgress {
  received: number;
  total: number;
  /** 0..1 (0 when total is unknown). */
  fraction: number;
}

export type UpdaterEvents = {
  status: { status: UpdaterStatus };
  progress: UpdateProgress;
  "update-available": UpdateInfo;
  error: { message: string };
};

type Listener<P> = (payload: P) => void;

export class Updater {
  #listeners = new Map<keyof UpdaterEvents, Set<Listener<unknown>>>();
  #status: UpdaterStatus = "idle";
  #info: VersionInfo | null | undefined; // undefined = not yet read
  #pending: UpdateInfo | null = null;
  #staged: string | null = null; // path to the extracted, verified .app
  #autoCheck: ReturnType<typeof setInterval> | undefined;

  /** Subscribe to an updater event. Returns an unsubscribe function. */
  on<K extends keyof UpdaterEvents>(type: K, listener: Listener<UpdaterEvents[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener as Listener<unknown>);
    return () => set!.delete(listener as Listener<unknown>);
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
  /** Whether this build has updates configured (packaged + `release` set). */
  get enabled(): boolean {
    return this.#version() != null;
  }

  /**
   * Fetch the channel manifest and report an available update, or `null` if the
   * app is up to date / updates aren't configured. Never throws.
   */
  async checkForUpdate(): Promise<UpdateInfo | null> {
    const v = this.#version();
    if (!v) return null;
    this.#setStatus("checking");
    try {
      const url = `${v.baseUrl.replace(/\/$/, "")}/${this.#prefix()}-update.json?t=${Date.now()}`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const m = (await res.json()) as {
        version: string;
        url: string;
        sha256: string;
        size?: number;
      };
      if (!m.version || m.version === v.version) {
        this.#setStatus("idle");
        return null;
      }
      const info: UpdateInfo = {
        version: m.version,
        currentVersion: v.version,
        channel: v.channel,
        url: m.url,
        sha256: m.sha256,
        size: m.size,
      };
      this.#pending = info;
      this.#setStatus("update-available");
      this.#emit("update-available", info);
      return info;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  /**
   * Download (and verify) the pending update's bundle into the app's support
   * dir. Emits `progress`. Call `checkForUpdate()` first.
   */
  async download(onProgress?: (p: UpdateProgress) => void): Promise<void> {
    const v = this.#version();
    if (!v || !this.#pending) throw new Error("no update to download — call checkForUpdate() first");
    const info = this.#pending;
    this.#setStatus("downloading");
    try {
      const dir = this.#updatesDir(v);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });

      const url = `${v.baseUrl.replace(/\/$/, "")}/${info.url}`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? info.size ?? 0);

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const p: UpdateProgress = { received, total, fraction: total ? received / total : 0 };
        this.#emit("progress", p);
        onProgress?.(p);
      }
      const buf = Buffer.concat(chunks);

      // Integrity: the manifest's sha256 must match the downloaded artifact.
      const got = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
      if (got !== info.sha256) {
        throw new Error(`hash mismatch (expected ${info.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
      }

      const tarPath = join(dir, "update.tar.gz");
      await Bun.write(tarPath, buf);
      await $`tar -xzf ${tarPath} -C ${dir}`.quiet();
      const staged = join(dir, `${v.name}.app`);
      if (!existsSync(staged)) throw new Error(`extracted bundle not found at ${staged}`);

      // Refuse a tampered/corrupt bundle (works for ad-hoc + Developer ID).
      const verify = await $`codesign --verify --deep --strict ${staged}`.quiet().nothrow();
      if (verify.exitCode !== 0) throw new Error("codesign verification failed on the downloaded update");

      this.#staged = staged;
      this.#setStatus("update-available");
    } catch (err) {
      this.#fail(err);
      throw err;
    }
  }

  /**
   * Swap the running `.app` with the downloaded bundle and relaunch. Spawns a
   * detached helper that waits for this process to exit, replaces the bundle,
   * strips quarantine, and reopens the app — then quits.
   */
  async applyAndRelaunch(): Promise<void> {
    const v = this.#version();
    if (!v || !this.#staged) throw new Error("no staged update — call download() first");
    this.#setStatus("applying");
    try {
      const runningApp = join(this.#resourcesDir()!, "..", "..");
      const script = [
        `APP=${sh(runningApp)}`,
        `NEW=${sh(this.#staged)}`,
        `PID=${process.pid}`,
        // Wait for the running app to fully exit before swapping.
        `while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done`,
        `sleep 0.3`,
        `rm -rf "$APP"`,
        `mv "$NEW" "$APP"`,
        `xattr -r -d com.apple.quarantine "$APP" 2>/dev/null || true`,
        `open "$APP"`,
      ].join("\n");

      Bun.spawn(["/bin/sh", "-c", script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).unref();

      this.#setStatus("complete");
      // Quit; the detached helper does the swap + relaunch after we exit.
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
      return undefined; // detached (not under the host)
    }
  }

  #prefix(): string {
    const v = this.#version()!;
    return `${v.channel}-darwin-${process.arch}`;
  }

  #updatesDir(v: VersionInfo): string {
    return join(homedir(), "Library", "Application Support", v.identifier, v.channel, "updates");
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
    this.#listeners.get(type)?.forEach((fn) => fn(payload));
    // Bridge to webviews so frontends can react without polling.
    try {
      runtime().rpc.broadcast(`mirin:updater:${type}`, payload);
    } catch {
      // detached / rpc not up — ignore
    }
  }
}

/** Single-quote a path for safe interpolation into a /bin/sh script. */
function sh(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export const updater = new Updater();
