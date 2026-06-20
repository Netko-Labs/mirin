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

import { $ } from "bun";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "./build.ts";
import { buildDmg, notarizeAndStaple, type DmgOptions } from "./dmg.ts";
import { buildNsisInstaller, hasMakensis } from "./installer-win.ts";
import { buildInnoInstaller, hasInno } from "./installer-inno.ts";
import { loadCodec } from "mirinjs/codec";

const sha256File = (path: string) =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

export async function release(projectDir = process.cwd()): Promise<number> {
  const result = await build(projectDir);
  if (!result.baseUrl) {
    console.error("[mirin release] no `release.baseUrl` in mirin.config.ts — nothing to publish.");
    return 1;
  }

  const isWindows = process.platform === "win32";
  const platform = isWindows ? "win32" : "darwin";
  const arch = process.arch; // "arm64" | "x64"
  const prefix = `${result.channel}-${platform}-${arch}`;
  const safeName = result.appName.replace(/[^A-Za-z0-9._-]/g, "");
  const base = result.baseUrl.replace(/\/$/, "");
  // The packaged unit: a flat app folder on Windows, an `.app` bundle on macOS.
  const appArtifact = isWindows ? result.appName : `${result.appName}.app`;

  const buildDir = join(projectDir, "build");
  const outDir = join(buildDir, "release");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Notarize + staple the .app (Developer ID, macOS) before packing, when
  // credentials are present. The .tar.zst / patch updater bundles are made from
  // this signed, stapled .app, so the updater swaps in an already-notarized app.
  if (!isWindows) await notarizeAndStaple(result.app);

  // Load the codec (zstd/bsdiff) from the *bundled* core, not the raw build output:
  // on Windows mirin_core.dll imports libcef.dll. The DLL loader resolves imports
  // from PATH (and the loader exe's dir), not the dll's own dir, so prepend the
  // bundle dir to PATH so libcef.dll is found. (On macOS the framework loads at
  // runtime, so result.coreDylib works directly.)
  const codecCore = isWindows ? join(result.app, "mirin_core.dll") : result.coreDylib;
  if (isWindows) process.env.PATH = `${result.app};${process.env.PATH ?? ""}`;
  const codec = loadCodec(codecCore);

  // Uncompressed tar — the identity + diff/patch basis (BSD tar keeps symlinks).
  const newTar = join(outDir, "_new.tar");
  await $`tar -cf ${newTar} -C ${buildDir} ${appArtifact}`;
  const tarHash = sha256File(newTar);

  // Full bundle: zstd(newTar).
  const bundleName = `${prefix}-${safeName}${isWindows ? "" : ".app"}.tar.zst`;
  const bundlePath = join(outDir, bundleName);
  console.log(`[mirin release] compressing → ${bundleName}`);
  codec.compress(newTar, bundlePath, 19);
  const bundleSha = sha256File(bundlePath);
  const bundleSize = readFileSync(bundlePath).byteLength;

  // Delta patch vs the previous release (if reachable). Best-effort.
  const patches: Array<{ fromVersion: string; url: string; sha256: string; size: number }> = [];
  try {
    const prevRes = await fetch(`${base}/${prefix}-update.json?t=${Date.now()}`, { redirect: "follow" });
    if (prevRes.ok) {
      const prev = (await prevRes.json()) as { version: string; bundle?: { url: string } };
      if (prev.version && prev.version !== result.version && prev.bundle?.url) {
        console.log(`[mirin release] generating delta ${prev.version} → ${result.version}…`);
        const tmp = join(tmpdir(), `mirin-release-${Date.now()}`);
        mkdirSync(tmp, { recursive: true });
        const prevZst = join(tmp, "prev.tar.zst");
        const dl = await fetch(`${base}/${prev.bundle.url}`, { redirect: "follow" });
        if (!dl.ok || !dl.body) throw new Error(`prev bundle ${dl.status}`);
        await Bun.write(prevZst, await dl.arrayBuffer());
        const prevTar = join(tmp, "prev.tar");
        codec.decompress(prevZst, prevTar);
        const rawPatch = join(tmp, "patch.bin");
        codec.diff(prevTar, newTar, rawPatch); // bsdiff
        const patchName = `${prefix}-${prev.version}.patch`;
        const patchPath = join(outDir, patchName);
        codec.compress(rawPatch, patchPath, 19);
        rmSync(tmp, { recursive: true, force: true });
        patches.push({
          fromVersion: prev.version,
          url: patchName,
          sha256: sha256File(patchPath),
          size: readFileSync(patchPath).byteLength,
        });
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
    tarHash,
    bundle: { url: bundleName, sha256: bundleSha, size: bundleSize },
    patches,
  };
  const manifestName = `${prefix}-update.json`;
  await Bun.write(join(outDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

  // Distributable installer for first-time installs (the updater uses the
  // .tar.zst/patch): a drag-to-Applications .dmg on macOS, a .zip of the app
  // folder on Windows.
  let installerName: string | undefined;
  let installerSize = 0;
  if (isWindows) {
    // A real installer (Program Files / per-user install, Start Menu + Desktop
    // shortcuts, uninstaller, Add/Remove Programs): Inno Setup (modern wizard)
    // preferred, then NSIS, then a portable .zip if neither toolchain is present.
    const setupName = `${prefix}-${safeName}-setup.exe`;
    const installerArgs = {
      appDir: result.app,
      appName: result.appName,
      exeName: `${result.appName}.exe`,
      version: result.version,
      bundleId: result.bundleId,
      outDir,
      fileName: setupName,
      projectDir: result.projectDir,
    };
    const innoWanted = result.inno !== false;
    const nsisWanted = result.nsis !== false;
    let exePath: string | undefined;
    if (innoWanted && hasInno()) {
      exePath = await buildInnoInstaller({
        ...installerArgs,
        options: typeof result.inno === "object" ? result.inno : {},
      });
    } else if (nsisWanted && (await hasMakensis())) {
      exePath = await buildNsisInstaller({
        ...installerArgs,
        options: typeof result.nsis === "object" ? result.nsis : {},
      });
    }
    if (exePath) {
      installerName = setupName;
      installerSize = readFileSync(exePath).byteLength;
    } else {
      if (innoWanted || nsisWanted) {
        console.warn(
          "[mirin release] no installer toolchain found — shipping the portable .zip. " +
            "Install Inno Setup (`scoop install inno-setup`) or NSIS (`scoop install nsis`).",
        );
      }
      installerName = `${prefix}-${safeName}.zip`;
      console.log(`[mirin release] zipping → ${installerName}`);
      const zipPath = join(outDir, installerName);
      rmSync(zipPath, { force: true });
      // bsdtar (Windows `tar`) creates a .zip from the extension with `-a`.
      await $`tar -a -cf ${zipPath} -C ${buildDir} ${appArtifact}`;
      installerSize = readFileSync(zipPath).byteLength;
    }
  } else if (result.dmg !== false) {
    // The DMG is the first-install convenience; the updater bundle + manifest (the
    // critical artifacts) are already built. Never fail the whole release over a
    // flaky installer step — warn loudly and ship the rest.
    const dmgName = `${prefix}-${safeName}.dmg`;
    console.log(`[mirin release] building installer → ${dmgName}`);
    try {
      const options: DmgOptions = typeof result.dmg === "object" ? result.dmg : {};
      const dmgPath = await buildDmg({
        app: result.app,
        appName: result.appName,
        outDir,
        fileName: dmgName,
        options,
        projectDir: result.projectDir,
        signIdentity: result.signIdentity,
      });
      await notarizeAndStaple(dmgPath); // no-op without notary credentials
      installerName = dmgName;
      installerSize = readFileSync(dmgPath).byteLength;
    } catch (e) {
      console.warn(
        `\n[mirin release] ⚠️  DMG build failed: ${e instanceof Error ? e.message : e}\n` +
          `[mirin release] shipping the updater bundle + manifest WITHOUT a .dmg installer.\n`,
      );
      rmSync(join(outDir, dmgName), { force: true });
    }
  }

  const mb = (n: number) => (n / 1e6).toFixed(1);
  console.log(`\n[mirin release] done → build/release/`);
  console.log(`  ${manifestName}`);
  console.log(`  ${bundleName} (${mb(bundleSize)} MB)`);
  for (const p of patches) console.log(`  ${p.url} (${mb(p.size)} MB delta from ${p.fromVersion})`);
  if (installerName) console.log(`  ${installerName} (${mb(installerSize)} MB installer)`);
  console.log(`\nUpload all of build/release/ to: ${result.baseUrl}`);
  if (existsSync(join(outDir, "_new.tar"))) rmSync(join(outDir, "_new.tar"), { force: true });
  return 0;
}
