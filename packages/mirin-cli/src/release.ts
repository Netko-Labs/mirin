/**
 * `mirin release` — build the app and emit flat-named update artifacts.
 *
 * Produces, under `build/release/`:
 *   {channel}-{platform}-{arch}-update.json   the manifest the app polls
 *   {channel}-{platform}-{arch}-{Name}.app.tar.gz   the full bundle
 *
 * These names are flat (no folders) so they upload as-is to GitHub Releases,
 * S3/R2, or any static host — whatever `release.baseUrl` points at. Channels
 * coexist at the same baseUrl because the channel is part of every filename.
 *
 * The app's `app.updater` polls `{baseUrl}/{prefix}-update.json`, compares the
 * advertised version to its own, downloads `url`, verifies `sha256`, then swaps
 * the whole `.app` and relaunches. (A signed/notarized `.app` must be replaced
 * whole — never modified in place — so the artifact is the entire bundle.)
 */

import { $ } from "bun";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.ts";

export async function release(projectDir = process.cwd()): Promise<number> {
  const result = await build(projectDir);
  if (!result.baseUrl) {
    console.error(
      "[mirin release] no `release.baseUrl` in mirin.config.ts — nothing to publish.",
    );
    return 1;
  }

  const platform = "darwin";
  const arch = process.arch; // "arm64" | "x64"
  const prefix = `${result.channel}-${platform}-${arch}`;
  // Sanitize the app name for a URL-safe artifact filename (spaces break hosts).
  const safeName = result.appName.replace(/[^A-Za-z0-9._-]/g, "");

  const buildDir = join(projectDir, "build");
  const outDir = join(buildDir, "release");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Notarize + staple before packing (so the shipped bundle passes Gatekeeper on
  // end-user machines), when notary credentials are present in the environment.
  const apple = process.env.MIRIN_NOTARY_APPLE_ID;
  const pw = process.env.MIRIN_NOTARY_PASSWORD;
  const team = process.env.MIRIN_NOTARY_TEAM_ID;
  if (apple && pw && team) {
    console.log("[mirin release] notarizing (this can take a few minutes)…");
    const zip = join(buildDir, "_notarize.zip");
    await $`ditto -c -k --keepParent ${result.app} ${zip}`;
    await $`xcrun notarytool submit ${zip} --apple-id ${apple} --password ${pw} --team-id ${team} --wait`;
    await $`xcrun stapler staple ${result.app}`;
    rmSync(zip, { force: true });
  }

  const tarName = `${prefix}-${safeName}.app.tar.gz`;
  const tarPath = join(outDir, tarName);

  console.log(`[mirin release] packing ${result.appName}.app → ${tarName}`);
  // BSD tar preserves the CEF framework's symlinks + executable bits.
  await $`tar -czf ${tarPath} -C ${buildDir} ${`${result.appName}.app`}`;

  const bytes = readFileSync(tarPath);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  const manifest = {
    version: result.version,
    channel: result.channel,
    platform,
    arch,
    url: tarName,
    sha256,
    size: bytes.byteLength,
  };
  const manifestName = `${prefix}-update.json`;
  await Bun.write(join(outDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

  const mb = (bytes.byteLength / 1e6).toFixed(1);
  console.log(`\n[mirin release] done → build/release/`);
  console.log(`  ${manifestName}`);
  console.log(`  ${tarName} (${mb} MB)`);
  console.log(`\nUpload both to: ${result.baseUrl}`);
  return 0;
}
