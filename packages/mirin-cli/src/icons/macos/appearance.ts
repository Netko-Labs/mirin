/**
 * Compile macOS appearance-variant app icons (light / dark / tinted, macOS 26+).
 *
 * `.icns` has no notion of appearance — the Dock picks a variant out of a
 * compiled asset catalog keyed by `CFBundleIconName`, and the only input that
 * produces one is an Icon Composer `.icon` document. `actool` compiles it to
 * the same `Assets.car` shape Apple's own bundled apps ship.
 *
 * Best-effort throughout: `actool` only ships with a full Xcode, so a machine
 * with just Command Line Tools warns and keeps the plain `.icns`.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

/** True when the source is an Icon Composer document, which actool reads directly. */
export const isIconComposerDoc = (path: string): boolean => path.endsWith(".icon");

/** Asset-catalog icon name; also the `CFBundleIconName` written to Info.plist. */
const ICON_NAME = "AppIcon";

/**
 * Locate `actool`. `xcrun` honours the selected developer dir, which is often
 * Command Line Tools (no actool), so fall back to a full Xcode if one is
 * installed but not selected.
 */
async function findActool(): Promise<string | undefined> {
  const xcrun = await $`xcrun --find actool`.nothrow().quiet();
  if (xcrun.exitCode === 0) {
    const path = xcrun.stdout.toString().trim();
    if (path && existsSync(path)) return path;
  }
  for (const app of ["/Applications/Xcode.app", "/Applications/Xcode-beta.app"]) {
    const path = join(app, "Contents/Developer/usr/bin/actool");
    if (existsSync(path)) return path;
  }
  return undefined;
}

export interface AppearanceCatalog {
  /** Goes in Info.plist as `CFBundleIconName`. */
  name: string;
  /** The legacy `.icns` actool derives alongside the catalog, if it emitted one. */
  icns?: string;
}

/**
 * Compile `icon` into `<Resources>/Assets.car`, or return undefined if the
 * catalog could not be built (no actool, unreadable art) — callers then keep
 * the plain `.icns` path.
 */
export async function writeAppearanceCatalog(
  iconDoc: string,
  resourcesDir: string,
  workDir: string,
): Promise<AppearanceCatalog | undefined> {
  // actool resolves its own arguments, so hand it absolute paths regardless of
  // what the caller passed and of the subprocess working directory.
  const resources = resolve(resourcesDir);
  const work = resolve(workDir);
  const actool = await findActool();
  if (!actool) {
    console.warn(
      "[mirin] actool not found — appearance variants need a full Xcode " +
        "(Command Line Tools alone is not enough); shipping the default icon only.",
    );
    return undefined;
  }

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const doc = join(work, `${ICON_NAME}.icon`);
  cpSync(iconDoc, doc, { recursive: true });

  const compiled = join(work, "compiled");
  mkdirSync(compiled, { recursive: true });
  const res =
    await $`${actool} --output-format human-readable-text --notices --warnings --app-icon ${ICON_NAME} --output-partial-info-plist ${join(work, "partial.plist")} --enable-on-demand-resources NO --target-device mac --minimum-deployment-target 26.0 --platform macosx --compile ${compiled} ${doc}`
      .nothrow()
      .quiet();

  const car = join(compiled, "Assets.car");
  if (res.exitCode !== 0 || !existsSync(car)) {
    console.warn(
      `[mirin] actool failed (exit ${res.exitCode}) — shipping the default icon only.\n` +
        res.stdout.toString().trim(),
    );
    return undefined;
  }

  cpSync(car, join(resources, "Assets.car"));
  const icns = join(compiled, `${ICON_NAME}.icns`);
  return { name: ICON_NAME, icns: existsSync(icns) ? icns : undefined };
}
