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
 * Every actool on this machine, newest Xcode first. `xcrun` alone is not
 * enough: it honours the selected developer dir, which is often Command Line
 * Tools (no actool) or an Xcode too old for Icon Composer documents.
 */
async function findActools(): Promise<string[]> {
  const found: string[] = [];
  const push = (path: string) => {
    if (existsSync(path) && !found.includes(path)) found.push(path);
  };
  // CI images install versioned Xcodes (Xcode_26.1.app, …); newest first, since
  // only recent actools can compile an Icon Composer document.
  const apps = (await $`ls -d /Applications/Xcode*.app`.nothrow().quiet()).stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .sort()
    .reverse();
  for (const app of apps) push(join(app.trim(), "Contents/Developer/usr/bin/actool"));
  const xcrun = await $`xcrun --find actool`.nothrow().quiet();
  if (xcrun.exitCode === 0) push(xcrun.stdout.toString().trim());
  return found;
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
  const actools = await findActools();
  if (actools.length === 0) {
    console.warn(
      "[mirin] actool not found — appearance variants need a full Xcode " +
        "(Command Line Tools alone is not enough).",
    );
    return undefined;
  }

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const doc = join(work, `${ICON_NAME}.icon`);
  cpSync(iconDoc, doc, { recursive: true });

  // Old actools exit 0 for an .icon document while emitting no catalog (they
  // warn that the platform can't target macOS 26), so success is judged by the
  // artifact, not the exit code — and every installed Xcode gets a turn.
  const car = join(work, "compiled", "Assets.car");
  let lastOutput = "";
  for (const actool of actools) {
    const compiled = join(work, "compiled");
    rmSync(compiled, { recursive: true, force: true });
    mkdirSync(compiled, { recursive: true });
    const res =
      await $`${actool} --output-format human-readable-text --notices --warnings --app-icon ${ICON_NAME} --output-partial-info-plist ${join(work, "partial.plist")} --enable-on-demand-resources NO --target-device mac --minimum-deployment-target 26.0 --platform macosx --compile ${compiled} ${doc}`
        .nothrow()
        .quiet();
    lastOutput = res.stdout.toString().trim();
    if (existsSync(car)) {
      cpSync(car, join(resources, "Assets.car"));
      const icns = join(compiled, `${ICON_NAME}.icns`);
      return { name: ICON_NAME, icns: existsSync(icns) ? icns : undefined };
    }
  }

  console.warn(
    `[mirin] no installed Xcode could compile the .icon document (tried ${actools.length}).\n` +
      lastOutput,
  );
  return undefined;
}
