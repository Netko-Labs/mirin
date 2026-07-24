import { rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { $ } from "bun";
import type { BuildResult } from "../build.ts";
import { buildDmg, type DmgOptions, notarizeAndStaple } from "../dmg.ts";
import { buildInnoInstaller, hasInno } from "../installer-inno.ts";
import { buildNsisInstaller, hasMakensis } from "../installer-win.ts";
import { buildLinuxPackages, resolveLinuxFormats } from "../package/linux/index.ts";

export interface ReleaseInstallerResult {
  installerName?: string;
  installerSize: number;
}

export interface ReleaseInstallerInput {
  result: BuildResult;
  buildDir: string;
  outDir: string;
  appArtifact: string;
  prefix: string;
  safeName: string;
  isWindows: boolean;
  isLinux: boolean;
}

/** Build first-install artifacts independently from updater compression and deltas. */
export async function buildReleaseInstaller(
  input: ReleaseInstallerInput,
): Promise<ReleaseInstallerResult> {
  const { result, isWindows, isLinux } = input;
  if (isWindows) return buildWindowsInstaller(input);
  if (isLinux) return buildLinuxInstallers(input);
  if (result.dmg !== false) return buildMacInstaller(input);
  return { installerSize: 0 };
}

async function buildWindowsInstaller(
  input: ReleaseInstallerInput,
): Promise<ReleaseInstallerResult> {
  const { result, buildDir, outDir, appArtifact, prefix, safeName } = input;
  const setupName = `${prefix}-${safeName}-setup.exe`;
  const installerArgs = {
    appDir: result.app,
    appName: result.appName,
    exeName: `${result.appName}.exe`,
    version: result.version,
    channel: result.channel,
    bundleId: result.bundleId,
    outDir,
    fileName: setupName,
    projectDir: result.projectDir,
  };
  const innoWanted = result.inno !== false;
  const nsisWanted = result.nsis !== false;
  const innoOpts = typeof result.inno === "object" ? result.inno : {};
  const nsisOpts = typeof result.nsis === "object" ? result.nsis : {};
  let exePath: string | undefined;

  if (innoWanted && hasInno()) {
    exePath = await buildInnoInstaller({
      ...installerArgs,
      options: { ...innoOpts, publisher: innoOpts.publisher ?? result.publisher },
    });
  } else if (nsisWanted && (await hasMakensis())) {
    exePath = await buildNsisInstaller({
      ...installerArgs,
      options: { ...nsisOpts, publisher: nsisOpts.publisher ?? result.publisher },
    });
  }

  if (exePath) return { installerName: setupName, installerSize: statSync(exePath).size };
  if (innoWanted || nsisWanted) {
    console.warn(
      "[mirin release] no installer toolchain found — shipping the portable .zip. " +
        "Install Inno Setup (`scoop install inno-setup`) or NSIS (`scoop install nsis`).",
    );
  }

  const installerName = `${prefix}-${safeName}.zip`;
  const zipPath = join(outDir, installerName);
  console.log(`[mirin release] zipping → ${installerName}`);
  rmSync(zipPath, { force: true });
  await $`tar -a -cf ${zipPath} -C ${buildDir} ${appArtifact}`;
  return { installerName, installerSize: statSync(zipPath).size };
}

async function buildLinuxInstallers(input: ReleaseInstallerInput): Promise<ReleaseInstallerResult> {
  const { result, outDir } = input;
  if (result.linux === false) return { installerSize: 0 };

  try {
    const formats = resolveLinuxFormats(result.linux);
    console.log(`[mirin release] building Linux packages (${formats.join(", ")})…`);
    const packages = await buildLinuxPackages({
      appDir: result.app,
      appName: result.appName,
      bundleId: result.bundleId,
      version: result.version,
      publisher: result.publisher,
      outDir,
      projectDir: result.projectDir,
      icon: result.icon,
      options: typeof result.linux === "object" ? result.linux : {},
      formats,
    });
    const primary = packages.find((artifact) => artifact.format === "appimage") ?? packages[0];
    for (const artifact of packages) {
      if (artifact !== primary) {
        console.log(`  ${basename(artifact.path)} (${(artifact.size / 1e6).toFixed(1)} MB)`);
      }
    }
    return primary
      ? { installerName: basename(primary.path), installerSize: primary.size }
      : { installerSize: 0 };
  } catch (error) {
    console.warn(
      `\n[mirin release] Linux packaging failed: ${error instanceof Error ? error.message : error}\n` +
        "[mirin release] shipping the updater bundle + manifest WITHOUT packages.\n",
    );
    return { installerSize: 0 };
  }
}

async function buildMacInstaller(input: ReleaseInstallerInput): Promise<ReleaseInstallerResult> {
  const { result, outDir, prefix, safeName } = input;
  const installerName = `${prefix}-${safeName}.dmg`;
  console.log(`[mirin release] building installer → ${installerName}`);
  try {
    const options: DmgOptions = typeof result.dmg === "object" ? result.dmg : {};
    const path = await buildDmg({
      app: result.app,
      appName: result.appName,
      outDir,
      fileName: installerName,
      options,
      projectDir: result.projectDir,
      signIdentity: result.signIdentity,
    });
    await notarizeAndStaple(path);
    return { installerName, installerSize: statSync(path).size };
  } catch (error) {
    console.warn(
      `\n[mirin release] DMG build failed: ${error instanceof Error ? error.message : error}\n` +
        "[mirin release] shipping the updater bundle + manifest WITHOUT a .dmg installer.\n",
    );
    rmSync(join(outDir, installerName), { force: true });
    return { installerSize: 0 };
  }
}
