/**
 * `mirin release` — build the app and emit flat-named update artifacts.
 *
 * Produces, under `build/release/`:
 *   {channel}-{platform}-{arch}-update.json          the manifest the app polls
 *   {channel}-{platform}-{arch}-update.json.sig      detached Ed25519 signature
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

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { build } from "./build.ts";
import { notarizeAndStaple } from "./dmg.ts";
import { buildReleaseInstaller } from "./release/installers.ts";
import {
  fetchTrustedReleaseUrl,
  RELEASE_ARTIFACT_TIMEOUT_MS,
  readPreviousReleaseManifest,
  readPreviousReleaseSignature,
  releaseArtifactUrl,
  trustedReleaseBaseUrl,
} from "./release/previous.ts";
import {
  assertUpdateSigningKey,
  signUpdateManifest,
  verifyUpdateManifest,
} from "./release/signature.ts";
import { writeAtomicOutputDirectory } from "./shared/fs/atomic-output.ts";
import { safeDestructiveDirectory } from "./shared/fs/project-source.ts";
import { validateAppIdentity } from "./shared/validation/config.ts";

// Level 10 keeps updater bundles compact without level 19's steep CPU cost.
// The native codec uses multiple workers, so this scales across CI runner cores.
const RELEASE_COMPRESSION_LEVEL = 10;
const MAX_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_TAR_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
// qbsdiff holds both sources and a suffix index in memory. Larger apps retain the
// full updater bundle but skip the optional delta instead of risking an OOM abort.
export const MAX_RELEASE_DELTA_SOURCE_BYTES = 128 * 1024 * 1024;

export function assertDeltaSourcesFitMemoryBudget(
  previousTarSize: number,
  newTarSize: number,
): void {
  if (
    previousTarSize > MAX_RELEASE_DELTA_SOURCE_BYTES ||
    newTarSize > MAX_RELEASE_DELTA_SOURCE_BYTES
  ) {
    throw new Error(
      `delta source tar exceeds the in-memory codec limit (${MAX_RELEASE_DELTA_SOURCE_BYTES} bytes)`,
    );
  }
}

export function validateReleaseManifestBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RELEASE_MANIFEST_BYTES) {
    throw new Error(
      `release manifest exceeds the updater limit (${MAX_RELEASE_MANIFEST_BYTES} bytes)`,
    );
  }
}

export function settleConcurrentReleaseTask<T>(task: Promise<T>): Promise<PromiseSettledResult<T>> {
  return task.then(
    (value): PromiseFulfilledResult<T> => ({ status: "fulfilled", value }),
    (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
  );
}

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
  // Release paths are destructive and artifact names are externally visible, so
  // defensively revalidate the BuildResult immediately before deriving either.
  validateAppIdentity({
    appName: result.appName,
    bundleId: result.bundleId,
    channel: result.channel,
    version: result.version,
  });
  if (!result.baseUrl) {
    console.error("[mirin release] no `release.baseUrl` in mirin.config.ts — nothing to publish.");
    return 1;
  }
  const updatePublicKey = result.updatePublicKey;
  if (!updatePublicKey) {
    throw new Error("[mirin release] packaged update public key is unavailable.");
  }
  assertUpdateSigningKey(updatePublicKey);

  const isWindows = process.platform === "win32";
  const isLinux = process.platform === "linux";
  const platform = isWindows ? "win32" : isLinux ? "linux" : "darwin";
  const arch = process.arch; // "arm64" | "x64"
  const prefix = `${result.channel}-${platform}-${arch}`;
  const safeName = result.appName.replace(/[^A-Za-z0-9._-]/g, "");
  const base = trustedReleaseBaseUrl(result.baseUrl);
  // The packaged unit: a flat app folder on Windows/Linux, an `.app` bundle on macOS.
  const appArtifact = isWindows || isLinux ? result.appName : `${result.appName}.app`;

  const buildDir = join(result.projectDir, "build");
  const outDir = safeDestructiveDirectory(
    result.projectDir,
    join(buildDir, "release"),
    "release output directory",
  );
  return writeAtomicOutputDirectory(
    result.projectDir,
    outDir,
    "release output directory",
    async (outDir) => {
      // Notarize + staple the .app (Developer ID, macOS) before packing, when
      // credentials are present. The .tar.zst / patch updater bundles are made from
      // this signed, stapled .app, so the updater swaps in an already-notarized app.
      if (!isWindows && !isLinux) await notarizeAndStaple(result.app);

      // Installer/package tooling runs in child processes and reads the assembled app.
      // Start it now so it overlaps updater compression and delta generation below.
      const installerBuild = settleConcurrentReleaseTask(
        buildReleaseInstaller({
          result,
          buildDir,
          outDir,
          appArtifact,
          prefix,
          safeName,
          isWindows,
          isLinux,
        }),
      );

      try {
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
          const [prevRes, signatureRes] = await Promise.all([
            fetchTrustedReleaseUrl(manifestUrl.toString()),
            fetchTrustedReleaseUrl(
              `${releaseArtifactUrl(base, `${prefix}-update.json.sig`)}?t=${Date.now()}`,
            ),
          ]);
          if (prevRes.ok && signatureRes.ok) {
            const previous = await readPreviousReleaseManifest(prevRes, {
              channel: result.channel,
              platform,
              arch,
            });
            verifyUpdateManifest(
              previous.bytes,
              await readPreviousReleaseSignature(signatureRes),
              updatePublicKey,
            );
            const prev = previous.manifest;
            if (prev.version !== result.version) {
              assertDeltaSourcesFitMemoryBudget(prev.tarSize, tarSize);
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
          console.warn(
            `[mirin release] skipping delta patch: ${e instanceof Error ? e.message : e}`,
          );
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
        const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
        validateReleaseManifestBytes(manifestBytes);
        await Bun.write(join(outDir, manifestName), manifestBytes);
        await Bun.write(
          join(outDir, `${manifestName}.sig`),
          `${signUpdateManifest(manifestBytes, updatePublicKey)}\n`,
        );

        const installerResult = await installerBuild;
        if (installerResult.status === "rejected") throw installerResult.reason;
        const { installerName, installerSize } = installerResult.value;

        const mb = (n: number) => (n / 1e6).toFixed(1);
        console.log("\n[mirin release] done → build/release/");
        console.log(`  ${manifestName}`);
        console.log(`  ${manifestName}.sig`);
        console.log(`  ${bundleName} (${mb(bundleSize)} MB)`);
        for (const p of patches)
          console.log(`  ${p.url} (${mb(p.size)} MB delta from ${p.fromVersion})`);
        if (installerName) console.log(`  ${installerName} (${mb(installerSize)} MB installer)`);
        console.log(`\nUpload all of build/release/ to: ${result.baseUrl}`);
        if (existsSync(join(outDir, "_new.tar"))) rmSync(join(outDir, "_new.tar"), { force: true });
        return 0;
      } finally {
        // Installer/package work shares the staging directory. Even when updater
        // generation fails first, settle it before atomic cleanup can remove paths
        // still owned by a child process. Preserve the original failure if both fail.
        await installerBuild;
      }
    },
  );
}

async function downloadVerified(
  url: string,
  destination: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const response = await fetchTrustedReleaseUrl(url, {
    timeoutMs: RELEASE_ARTIFACT_TIMEOUT_MS,
  });
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
