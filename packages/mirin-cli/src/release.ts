/**
 * `mirin release` — build the app and emit flat-named update artifacts.
 *
 * Produces, under `build/release/`:
 *   {channel}-{platform}-{arch}-update.json          the manifest the app polls
 *   {channel}-{platform}-{arch}-{Name}.app.tar.zst   the full bundle (fallback)
 *   {channel}-{platform}-{arch}-{prevVersion}.patch  delta from the previous release
 *
 * The bundle is a zstd-compressed tar of the whole signed `.app`. Identity is the
 * SHA-256 of the *uncompressed* tar (`tarHash`), so a delta patch can reconstruct
 * it exactly. When the previous release is reachable at `baseUrl`, a bsdiff patch
 * (prev → this) is generated; the app applies it instead of re-downloading the
 * whole bundle, falling back to the full bundle whenever a patch isn't usable.
 *
 * Names are flat (no folders) so they upload as-is to GitHub Releases, S3/R2, or
 * any static host. Channels coexist because the channel is part of every name.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { build } from "./build.ts";
import { notarizeAndStaple } from "./dmg.ts";
import { buildReleaseInstaller } from "./release/installers.ts";
import {
  assertTrustedReleaseUrl,
  readPreviousReleaseManifest,
  releaseArtifactUrl,
  trustedReleaseBaseUrl,
} from "./release/previous.ts";

// Level 10 keeps updater bundles compact without level 19's steep CPU cost.
// The native codec uses multiple workers, so this scales across CI runner cores.
const RELEASE_COMPRESSION_LEVEL = 10;
const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_TAR_BYTES = 8 * 1024 * 1024 * 1024;

interface ReleaseCodec {
  compress(src: string, dst: string, level: number): void;
  decompressBounded(src: string, dst: string, maxOutputBytes: number): void;
  diff(oldPath: string, newPath: string, patchPath: string): void;
}

export function createReleaseCodec(binary: string): ReleaseCodec {
  const run = (operation: string, ...args: string[]) => {
    const result = Bun.spawnSync({
      cmd: [binary, operation, ...args],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) throw new Error(`codec ${operation} failed`);
  };
  return {
    compress(src, dst, level) {
      run("compress", src, dst, String(level));
    },
    decompressBounded(src, dst, maxOutputBytes) {
      run("decompress-bounded", src, dst, String(maxOutputBytes));
    },
    diff(oldPath, newPath, patchPath) {
      run("diff", oldPath, newPath, patchPath);
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

export async function release(projectDir = process.cwd()): Promise<number> {
  const result = await build(projectDir);
  if (!result.baseUrl) {
    console.error("[mirin release] no `release.baseUrl` in mirin.config.ts — nothing to publish.");
    return 1;
  }

  const isWindows = process.platform === "win32";
  const isLinux = process.platform === "linux";
  const platform = isWindows ? "win32" : isLinux ? "linux" : "darwin";
  const arch = process.arch; // "arm64" | "x64"
  const prefix = `${result.channel}-${platform}-${arch}`;
  const safeName = result.appName.replace(/[^A-Za-z0-9._-]/g, "");
  const base = trustedReleaseBaseUrl(result.baseUrl);
  // The packaged unit: a flat app folder on Windows/Linux, an `.app` bundle on macOS.
  const appArtifact = isWindows || isLinux ? result.appName : `${result.appName}.app`;

  const buildDir = join(projectDir, "build");
  const outDir = join(buildDir, "release");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Notarize + staple the .app (Developer ID, macOS) before packing, when
  // credentials are present. The .tar.zst / patch updater bundles are made from
  // this signed, stapled .app, so the updater swaps in an already-notarized app.
  if (!isWindows && !isLinux) await notarizeAndStaple(result.app);

  // Installer/package tooling runs in child processes and reads the assembled app.
  // Start it now so it overlaps updater compression and delta generation below.
  const installerBuild = buildReleaseInstaller({
    result,
    buildDir,
    outDir,
    appArtifact,
    prefix,
    safeName,
    isWindows,
    isLinux,
  });

  // Release tooling runs in plain Bun, including Windows arm64 builds where
  // bun:ffi is unavailable. The standalone helper also avoids loading CEF merely
  // to compress updater artifacts.
  const codec = createReleaseCodec(result.codecBin);

  // Uncompressed tar — the identity + diff/patch basis (BSD tar keeps symlinks).
  const newTar = join(outDir, "_new.tar");
  await $`tar -cf ${newTar} -C ${buildDir} ${appArtifact}`.env({
    ...process.env,
    COPYFILE_DISABLE: "1",
  });
  const tarHash = await sha256File(newTar);
  const tarSize = statSync(newTar).size;
  if (tarSize <= 0 || tarSize > MAX_RELEASE_TAR_BYTES) {
    throw new Error(`release tar exceeds the updater limit (${MAX_RELEASE_TAR_BYTES} bytes)`);
  }

  // Full bundle: zstd(newTar).
  const bundleName = `${prefix}-${safeName}${isWindows ? "" : ".app"}.tar.zst`;
  const bundlePath = join(outDir, bundleName);
  console.log(`[mirin release] compressing → ${bundleName}`);
  codec.compress(newTar, bundlePath, RELEASE_COMPRESSION_LEVEL);
  const bundleSha = await sha256File(bundlePath);
  const bundleSize = statSync(bundlePath).size;
  if (bundleSize <= 0 || bundleSize > MAX_RELEASE_ARTIFACT_BYTES) {
    throw new Error(
      `release bundle exceeds the updater limit (${MAX_RELEASE_ARTIFACT_BYTES} bytes)`,
    );
  }

  // Delta patch vs the previous release (if reachable). Best-effort.
  const patches: Array<{
    fromVersion: string;
    url: string;
    sha256: string;
    size: number;
    uncompressedSize: number;
  }> = [];
  try {
    const manifestUrl = new URL(releaseArtifactUrl(base, `${prefix}-update.json`));
    manifestUrl.searchParams.set("t", String(Date.now()));
    const prevRes = await fetch(manifestUrl, {
      redirect: "follow",
    });
    assertTrustedReleaseUrl(prevRes.url);
    if (prevRes.ok) {
      const prev = await readPreviousReleaseManifest(prevRes, {
        channel: result.channel,
        platform,
        arch,
      });
      if (prev.version !== result.version) {
        console.log(`[mirin release] generating delta ${prev.version} → ${result.version}…`);
        const tmp = mkdtempSync(join(tmpdir(), "mirin-release-"));
        try {
          const prevZst = join(tmp, "prev.tar.zst");
          await downloadVerified(
            releaseArtifactUrl(base, prev.bundle.url),
            prevZst,
            prev.bundle.sha256,
            prev.bundle.size,
          );
          const prevTar = join(tmp, "prev.tar");
          codec.decompressBounded(prevZst, prevTar, prev.tarSize);
          if (statSync(prevTar).size !== prev.tarSize) {
            throw new Error("previous bundle decompressed size mismatch");
          }
          const rawPatch = join(tmp, "patch.bin");
          codec.diff(prevTar, newTar, rawPatch); // bsdiff
          const uncompressedSize = statSync(rawPatch).size;
          if (uncompressedSize <= 0 || uncompressedSize > MAX_RELEASE_ARTIFACT_BYTES) {
            throw new Error("delta patch exceeds the updater limit");
          }
          const patchName = `${prefix}-${prev.version}.patch`;
          const patchPath = join(outDir, patchName);
          codec.compress(rawPatch, patchPath, RELEASE_COMPRESSION_LEVEL);
          const patchSize = statSync(patchPath).size;
          if (patchSize <= 0 || patchSize > MAX_RELEASE_ARTIFACT_BYTES) {
            throw new Error("compressed delta patch exceeds the updater limit");
          }
          patches.push({
            fromVersion: prev.version,
            url: patchName,
            sha256: await sha256File(patchPath),
            size: patchSize,
            uncompressedSize,
          });
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    }
  } catch (e) {
    console.warn(`[mirin release] skipping delta patch: ${e instanceof Error ? e.message : e}`);
  }

  rmSync(newTar, { force: true });

  const manifest = {
    version: result.version,
    channel: result.channel,
    platform,
    arch,
    body: result.releaseNotes,
    tarHash,
    tarSize,
    bundle: { url: bundleName, sha256: bundleSha, size: bundleSize },
    patches,
  };
  const manifestName = `${prefix}-update.json`;
  await Bun.write(join(outDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

  const { installerName, installerSize } = await installerBuild;

  const mb = (n: number) => (n / 1e6).toFixed(1);
  console.log("\n[mirin release] done → build/release/");
  console.log(`  ${manifestName}`);
  console.log(`  ${bundleName} (${mb(bundleSize)} MB)`);
  for (const p of patches) console.log(`  ${p.url} (${mb(p.size)} MB delta from ${p.fromVersion})`);
  if (installerName) console.log(`  ${installerName} (${mb(installerSize)} MB installer)`);
  console.log(`\nUpload all of build/release/ to: ${result.baseUrl}`);
  if (existsSync(join(outDir, "_new.tar"))) rmSync(join(outDir, "_new.tar"), { force: true });
  return 0;
}

async function downloadVerified(
  url: string,
  destination: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  assertTrustedReleaseUrl(response.url);
  if (!response.ok || !response.body) throw new Error(`previous bundle ${response.status}`);

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 0 && contentLength !== expectedSize) {
    throw new Error(
      `previous bundle size mismatch (expected ${expectedSize}, got ${contentLength})`,
    );
  }

  const reader = response.body.getReader();
  const writer = Bun.file(destination).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let received = 0;
  try {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > expectedSize) throw new Error("previous bundle exceeds declared size");
        hasher.update(value);
        writer.write(value);
      }
    } finally {
      await writer.end();
    }
    if (received !== expectedSize) {
      throw new Error(`previous bundle size mismatch (expected ${expectedSize}, got ${received})`);
    }
    if (hasher.digest("hex") !== expectedSha256) {
      throw new Error("previous bundle checksum mismatch");
    }
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}
