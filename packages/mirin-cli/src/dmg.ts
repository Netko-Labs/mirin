/**
 * macOS `.dmg` installer for `mirin release`.
 *
 * Two paths:
 *  - **plain** (default): stage the `.app` + an `/Applications` symlink, then
 *    `hdiutil create … -format ULFO`. Rock-solid in CI — this is what ships when
 *    `dmg: true`. ULFO (lzfse) handles large CEF frameworks best on modern macOS.
 *  - **laid-out**: when a `background` or any window/icon position is configured,
 *    build a read-write image, style the Finder window via AppleScript, then
 *    convert to the compressed read-only format. Best-effort — falls back to the
 *    plain DMG if Finder automation isn't available (e.g. a headless runner).
 *
 * The DMG is codesigned (a DMG carries no entitlements / hardened runtime — it's
 * not executable code) and, when notary credentials are present, notarized +
 * stapled so a fresh download opens without a Gatekeeper prompt.
 */

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { $ } from "bun";

export interface DmgOptions {
  volumeName?: string;
  format?: "ULFO" | "UDZO" | "UDBZ";
  background?: string;
  windowSize?: { width: number; height: number };
  iconSize?: number;
  appPosition?: { x: number; y: number };
  applicationsPosition?: { x: number; y: number };
}

export interface BuildDmgInput {
  /** Path to the (signed) `.app`. */
  app: string;
  appName: string;
  /** Output directory for the `.dmg`. */
  outDir: string;
  /** Output file name (e.g. `stable-darwin-arm64-Anko.dmg`). */
  fileName: string;
  /** Resolved DMG options. */
  options: DmgOptions;
  /** Project root, for resolving a relative `background` path. */
  projectDir: string;
  /** Codesign identity ("-"/undefined → ad-hoc, no notarization). */
  signIdentity?: string;
}

/** hdiutil volume names choke on some punctuation; keep it tame but readable. */
function volumeName(name: string): string {
  return name.replace(/[/:\\]/g, " ").trim() || "App";
}

/**
 * Notarize + staple a `.app` or `.dmg` using MIRIN_NOTARY_* env credentials.
 * No-op (returns false) when credentials are absent. Throws on rejection,
 * printing the notary log so the failure is diagnosable.
 */
export async function notarizeAndStaple(target: string): Promise<boolean> {
  const apple = process.env.MIRIN_NOTARY_APPLE_ID;
  const pw = process.env.MIRIN_NOTARY_PASSWORD;
  const team = process.env.MIRIN_NOTARY_TEAM_ID;
  if (!apple || !pw || !team) return false;

  const isApp = target.endsWith(".app");
  // notarytool wants a zip for a bundle; a .dmg is submitted as-is.
  const submitPath = isApp ? `${target}.notarize.zip` : target;
  if (isApp) await $`ditto -c -k --keepParent ${target} ${submitPath}`;

  console.log(`[mirin release] notarizing ${basename(target)} (this can take a few minutes)…`);
  const out =
    await $`xcrun notarytool submit ${submitPath} --apple-id ${apple} --password ${pw} --team-id ${team} --wait --output-format json`.text();
  if (isApp) rmSync(submitPath, { force: true });

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
  await $`xcrun stapler staple ${target}`;
  return true;
}

/**
 * `hdiutil create` with retries. "Resource busy" is a transient CI flake — a
 * Spotlight/antivirus/`fseventsd` process touches the staging folder (or a prior
 * image hasn't fully detached) while hdiutil tries to read it. A short backoff
 * clears it; only a non-busy error fails immediately.
 */
async function hdiutilCreate(
  vol: string,
  staging: string,
  format: string,
  dmgPath: string,
): Promise<void> {
  let stderr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res =
      await $`hdiutil create -volname ${vol} -srcfolder ${staging} -ov -format ${format} ${dmgPath}`
        .quiet()
        .nothrow();
    if (res.exitCode === 0) return;
    stderr = res.stderr.toString().trim();
    if (!/busy/i.test(stderr)) break; // not the transient flake — fail now
    console.warn(`[mirin release] hdiutil create busy (attempt ${attempt}/4); retrying…`);
    rmSync(dmgPath, { force: true });
    await Bun.sleep(3000 * attempt);
  }
  throw new Error(`hdiutil create failed: ${stderr}`);
}

/** Does this config ask for a styled Finder window (vs. a plain DMG)? */
function wantsLayout(o: DmgOptions): boolean {
  return !!(o.background || o.appPosition || o.applicationsPosition || o.windowSize || o.iconSize);
}

/**
 * Build (and codesign) the `.dmg`, returning its path. Notarization is the
 * caller's responsibility (so it can be sequenced with the other artifacts).
 */
export async function buildDmg(input: BuildDmgInput): Promise<string> {
  const { app, appName, outDir, fileName, options, projectDir, signIdentity } = input;
  const vol = volumeName(options.volumeName ?? appName);
  const format = options.format ?? "ULFO";
  const dmgPath = join(outDir, fileName);
  rmSync(dmgPath, { force: true });

  const staging = join(tmpdir(), `mirin-dmg-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    // BSD cp -R preserves the bundle's symlinks/signatures.
    await $`cp -R ${app} ${join(staging, basename(app))}`;
    symlinkSync("/Applications", join(staging, "Applications"));

    let built = false;
    if (wantsLayout(options)) {
      try {
        await buildLaidOutDmg({
          staging,
          vol,
          format,
          dmgPath,
          options,
          projectDir,
          appFile: basename(app),
        });
        built = true;
      } catch (e) {
        console.warn(
          `[mirin release] DMG layout failed (${e instanceof Error ? e.message : e}); ` +
            "falling back to a plain DMG.",
        );
        rmSync(dmgPath, { force: true });
      }
    }
    if (!built) {
      await hdiutilCreate(vol, staging, format, dmgPath);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // Sign the image itself (Gatekeeper checks the DMG's signature too).
  if (signIdentity && signIdentity !== "-") {
    await $`codesign --force --timestamp --sign ${signIdentity} ${dmgPath}`.quiet();
  } else if (signIdentity === "-") {
    await $`codesign --force --sign - ${dmgPath}`.quiet();
  }
  return dmgPath;
}

/**
 * Read-write image → style the Finder window via AppleScript → convert to the
 * compressed read-only `format`. Throws if any step fails (caller falls back).
 */
async function buildLaidOutDmg(args: {
  staging: string;
  vol: string;
  format: string;
  dmgPath: string;
  options: DmgOptions;
  projectDir: string;
  appFile: string;
}): Promise<void> {
  const { staging, vol, format, dmgPath, options, projectDir, appFile } = args;
  const win = options.windowSize ?? { width: 640, height: 400 };
  const iconSize = options.iconSize ?? 128;
  const appPos = options.appPosition ?? {
    x: Math.round(win.width * 0.25),
    y: Math.round(win.height * 0.5),
  };
  const appsPos = options.applicationsPosition ?? {
    x: Math.round(win.width * 0.75),
    y: Math.round(win.height * 0.5),
  };

  // Stage a background image (if any) under a hidden folder Finder can reference.
  let bgFile: string | undefined;
  if (options.background) {
    const src = isAbsolute(options.background)
      ? options.background
      : join(projectDir, options.background);
    if (!existsSync(src)) throw new Error(`background not found: ${src}`);
    const bgDir = join(staging, ".background");
    mkdirSync(bgDir, { recursive: true });
    const ext = src.slice(src.lastIndexOf("."));
    bgFile = `bg${ext}`;
    cpSync(src, join(bgDir, bgFile));
  }

  const rw = `${dmgPath}.rw.dmg`;
  rmSync(rw, { force: true });
  // Read-write image sized to the staged contents, with slack for HFS overhead.
  await $`hdiutil create -volname ${vol} -srcfolder ${staging} -fs HFS+ -format UDRW -ov ${rw}`.quiet();

  // Attach without auto-opening a Finder window; parse the real mountpoint.
  const attach = await $`hdiutil attach ${rw} -readwrite -noverify -noautoopen`.text();
  const mount = attach
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes("/Volumes/"))
    ?.split("\t")
    .pop()
    ?.trim();
  if (!mount || !existsSync(mount)) {
    await $`hdiutil detach ${rw}`.quiet().catch(() => {});
    throw new Error("could not resolve DMG mountpoint");
  }

  try {
    const bgClause = bgFile
      ? `set background picture of viewOptions to file ".background:${bgFile}"`
      : "";
    const script = `
      tell application "Finder"
        tell disk "${vol}"
          open
          set current view of container window to icon view
          set toolbar visible of container window to false
          set statusbar visible of container window to false
          set the bounds of container window to {200, 120, ${200 + win.width}, ${120 + win.height}}
          set viewOptions to the icon view options of container window
          set arrangement of viewOptions to not arranged
          set icon size of viewOptions to ${iconSize}
          ${bgClause}
          set position of item "${appFile}" of container window to {${appPos.x}, ${appPos.y}}
          set position of item "Applications" of container window to {${appsPos.x}, ${appsPos.y}}
          update without registering applications
          delay 1
          close
        end tell
      end tell`;
    await $`osascript -e ${script}`.quiet();
    await $`sync`.quiet().catch(() => {});
  } finally {
    await $`hdiutil detach ${mount}`.quiet().catch(async () => {
      await $`hdiutil detach ${rw} -force`.quiet().catch(() => {});
    });
  }

  await $`hdiutil convert ${rw} -format ${format} -ov -o ${dmgPath}`.quiet();
  rmSync(rw, { force: true });
}
