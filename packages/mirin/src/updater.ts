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

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { $ } from "bun";
import { runtime } from "./runtime.ts";
import { loadCodec } from "./codec.ts";

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

/** The published-release manifest ({prefix}-update.json). */
interface Manifest {
  version: string;
  channel: string;
  platform: string;
  arch: string;
  /** SHA-256 of the uncompressed bundle tar (update identity + integrity). */
  tarHash: string;
  bundle: { url: string; sha256: string; size?: number };
  patches?: Array<{ fromVersion: string; url: string; sha256: string; size?: number }>;
}

/** A published release the running app can update to. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  channel: string;
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
  #info: VersionInfo | null | undefined;
  #manifest: Manifest | null = null;
  #staged: string | null = null;
  #autoCheck: ReturnType<typeof setInterval> | undefined;

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
      const url = `${v.baseUrl.replace(/\/$/, "")}/${this.#prefix()}-update.json?t=${Date.now()}`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const m = (await res.json()) as Manifest;
      if (!m.version || m.version === v.version) {
        this.#manifest = null;
        this.#setStatus("idle");
        return null;
      }
      this.#manifest = m;
      const info: UpdateInfo = { version: m.version, currentVersion: v.version, channel: v.channel };
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
   * version when available, else the full bundle. Emits `progress`.
   */
  async download(onProgress?: (p: UpdateProgress) => void): Promise<void> {
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

      const base = v.baseUrl.replace(/\/$/, "");
      const newTar = join(work, "new.tar");
      const cachedTar = join(tarsDir, `${v.version}.tar`);
      const patch = m.patches?.find((p) => p.fromVersion === v.version);

      let ok = false;
      if (patch && existsSync(cachedTar)) {
        try {
          const patchZst = join(work, "patch.zst");
          await this.#fetchToFile(`${base}/${patch.url}`, patchZst, patch.sha256, onProgress);
          const patchRaw = join(work, "patch.bin");
          codec.decompress(patchZst, patchRaw);
          codec.patch(cachedTar, patchRaw, newTar); // bspatch
          await this.#verify(newTar, m.tarHash);
          ok = true;
        } catch {
          ok = false; // delta failed → full bundle
        }
      }
      if (!ok) {
        const bundleZst = join(work, "bundle.tar.zst");
        await this.#fetchToFile(`${base}/${m.bundle.url}`, bundleZst, m.bundle.sha256, onProgress);
        codec.decompress(bundleZst, newTar);
        await this.#verify(newTar, m.tarHash);
      }

      // Cache the new tar (for the next delta) and extract for swapping.
      const keepTar = join(tarsDir, `${m.version}.tar`);
      rmSync(keepTar, { force: true });
      renameSync(newTar, keepTar);
      await $`tar -xf ${keepTar} -C ${work}`.quiet();
      const staged = join(work, `${v.name}.app`);
      if (!existsSync(staged)) throw new Error(`extracted bundle not found at ${staged}`);

      const verify = await $`codesign --verify --deep --strict ${staged}`.quiet().nothrow();
      if (verify.exitCode !== 0) throw new Error("codesign verification failed on the downloaded update");

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
      const runningApp = join(this.#resourcesDir()!, "..", "..");
      const script = [
        `APP=${sh(runningApp)}`,
        `NEW=${sh(this.#staged)}`,
        `PID=${process.pid}`,
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

  async #fetchToFile(
    url: string,
    dest: string,
    expectedSha: string,
    onProgress?: (p: UpdateProgress) => void,
  ): Promise<void> {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    const total = Number(res.headers.get("content-length") ?? 0);
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
    const got = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
    if (got !== expectedSha) throw new Error("download hash mismatch");
    await Bun.write(dest, buf);
  }

  async #verify(file: string, expectedSha: string): Promise<void> {
    const buf = await Bun.file(file).bytes();
    const got = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
    if (got !== expectedSha) throw new Error("reconstructed bundle hash mismatch");
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
    return `${this.#version()!.channel}-darwin-${process.arch}`;
  }

  #supportDir(v: VersionInfo): string {
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
    this.#listeners.get(type)?.forEach((fn) => fn(payload));
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
