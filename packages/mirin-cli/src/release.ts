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
import { loadCodec } from "mirinjs/codec";

const sha256File = (path: string) =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

export async function release(projectDir = process.cwd()): Promise<number> {
  const result = await build(projectDir);
  if (!result.baseUrl) {
    console.error("[mirin release] no `release.baseUrl` in mirin.config.ts — nothing to publish.");
    return 1;
  }

  const platform = "darwin";
  const arch = process.arch; // "arm64" | "x64"
  const prefix = `${result.channel}-${platform}-${arch}`;
  const safeName = result.appName.replace(/[^A-Za-z0-9._-]/g, "");
  const base = result.baseUrl.replace(/\/$/, "");

  const buildDir = join(projectDir, "build");
  const outDir = join(buildDir, "release");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Optional notarize + staple (Developer ID) before packing, when configured.
  const apple = process.env.MIRIN_NOTARY_APPLE_ID;
  const pw = process.env.MIRIN_NOTARY_PASSWORD;
  const team = process.env.MIRIN_NOTARY_TEAM_ID;
  if (apple && pw && team) {
    console.log("[mirin release] notarizing (this can take a few minutes)…");
    const zip = join(buildDir, "_notarize.zip");
    await $`ditto -c -k --keepParent ${result.app} ${zip}`;
    // `notarytool submit --wait` exits 0 even when the result is "Invalid", so
    // parse the JSON status ourselves and surface the notary log on rejection —
    // otherwise the only symptom is a confusing `stapler` failure downstream.
    const out =
      await $`xcrun notarytool submit ${zip} --apple-id ${apple} --password ${pw} --team-id ${team} --wait --output-format json`.text();
    rmSync(zip, { force: true });
    let sub: { id?: string; status?: string } = {};
    try {
      sub = JSON.parse(out);
    } catch {
      console.error(out);
    }
    if (sub.status !== "Accepted") {
      console.error(`[mirin release] notarization ${sub.status ?? "failed"} (id: ${sub.id ?? "?"})`);
      if (sub.id) {
        const log =
          await $`xcrun notarytool log ${sub.id} --apple-id ${apple} --password ${pw} --team-id ${team}`
            .text()
            .catch(() => "");
        if (log) console.error(log);
      }
      throw new Error(`notarization not accepted: ${sub.status ?? "unknown"}`);
    }
    await $`xcrun stapler staple ${result.app}`;
  }

  const codec = loadCodec(result.coreDylib);

  // Uncompressed tar — the identity + diff/patch basis (BSD tar keeps symlinks).
  const newTar = join(outDir, "_new.tar");
  await $`tar -cf ${newTar} -C ${buildDir} ${`${result.appName}.app`}`;
  const tarHash = sha256File(newTar);

  // Full bundle: zstd(newTar).
  const bundleName = `${prefix}-${safeName}.app.tar.zst`;
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

  const mb = (n: number) => (n / 1e6).toFixed(1);
  console.log(`\n[mirin release] done → build/release/`);
  console.log(`  ${manifestName}`);
  console.log(`  ${bundleName} (${mb(bundleSize)} MB)`);
  for (const p of patches) console.log(`  ${p.url} (${mb(p.size)} MB delta from ${p.fromVersion})`);
  console.log(`\nUpload all of build/release/ to: ${result.baseUrl}`);
  if (existsSync(join(outDir, "_new.tar"))) rmSync(join(outDir, "_new.tar"), { force: true });
  return 0;
}
