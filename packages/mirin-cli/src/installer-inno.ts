/**
 * Windows installer via **Inno Setup** — a modern, clean wizard (the installer VS
 * Code ships). Generates an `.iss` script from the app folder + config and compiles
 * it with `iscc`. Like the NSIS path it installs per-user (`%LOCALAPPDATA%\Programs`,
 * no elevation) or per-machine (Program Files), creates Start Menu + Desktop
 * shortcuts, and registers an uninstaller / Add-Remove-Programs entry — but with
 * Inno's `WizardStyle=modern` flat UI instead of NSIS's dated one.
 *
 * Requires `iscc` (Inno Setup 6+) on PATH; the caller checks `hasInno()` and falls
 * back to NSIS / the portable `.zip` when it's absent.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { $ } from "bun";
import type { InnoConfig } from "mirinjs";
import { makeWindowsIcon } from "./icons/windows/index.ts";
import { validateAppIdentity } from "./shared/validation/config.ts";

export interface BuildInnoInput {
  appDir: string; // the assembled app folder (build/<App>)
  appName: string;
  exeName: string; // <App>.exe
  version: string;
  channel: string;
  bundleId: string; // reverse-DNS id → AppId / uninstall key
  outDir: string; // build/release
  fileName: string; // e.g. stable-win32-x64-Anko-setup.exe
  options: InnoConfig;
  projectDir: string;
}

/** Whether the Inno Setup compiler `iscc` is on PATH. */
export function hasInno(): boolean {
  return Bun.which("iscc") != null;
}

const resolve = (projectDir: string, p: string) => (isAbsolute(p) ? p : join(projectDir, p));
/** Escape an Inno directive value: `{` is the constant sigil. */
const v = (value: string): string => {
  if (/[\0\r\n]/.test(value)) throw new Error("inno: values cannot contain control characters");
  return value.replace(/\{/g, "{{");
};

/** Build the installer with `iscc`, returning the setup.exe path. */
export async function buildInnoInstaller(input: BuildInnoInput): Promise<string> {
  const identity = validateAppIdentity({
    appName: input.appName,
    bundleId: input.bundleId,
    version: input.version,
    channel: input.channel,
  });
  const { appName, bundleId, version } = identity;
  const { appDir, exeName, outDir, fileName, options, projectDir } = input;
  if (exeName !== `${appName}.exe`) throw new Error(`inno: exeName must be ${appName}.exe`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(fileName) || fileName.length > 255) {
    throw new Error("inno: fileName must be a flat portable .exe name");
  }
  const out = join(outDir, fileName);
  rmSync(out, { force: true });
  const baseName = fileName.slice(0, -".exe".length);

  const perMachine = options.perMachine === true;
  const minimal = options.oneClick === true;
  const desktop = options.desktopShortcut !== false;
  const startMenu = options.startMenuShortcut !== false;
  const runAfter = options.runAfterFinish !== false;
  const changeDir = options.allowChangeInstallDir !== false && !minimal;
  const publisher = options.publisher ?? appName;
  const installDir =
    options.installDir ??
    (perMachine ? "{autopf}\\" + appName : "{localappdata}\\Programs\\" + appName);

  // Setup icon: an explicit .ico, else the app's bundled icon.ico.
  let icon: string | undefined;
  if (options.installerIcon) {
    icon = makeWindowsIcon(resolve(projectDir, options.installerIcon), join(outDir, "_inno.ico"));
  } else if (existsSync(join(appDir, "icon.ico"))) {
    icon = join(appDir, "icon.ico");
  }
  const license = options.license ? resolve(projectDir, options.license) : undefined;
  if (license && !existsSync(license)) throw new Error(`inno: license not found: ${license}`);

  const L: string[] = [];
  L.push("[Setup]");
  L.push(`AppId={{${bundleId}}`);
  L.push(`AppName=${v(appName)}`);
  L.push(`AppVersion=${v(version)}`);
  // Without this, Inno's display name defaults to "<name> version <x>" (shown in
  // the wizard title + Add/Remove Programs); pin it to the app name.
  L.push(`AppVerName=${v(appName)}`);
  L.push(`AppPublisher=${v(publisher)}`);
  L.push("WizardStyle=modern");
  L.push(`DefaultDirName=${installDir}`);
  L.push(`DefaultGroupName=${v(appName)}`);
  L.push(`PrivilegesRequired=${perMachine ? "admin" : "lowest"}`);
  L.push(`OutputDir=${outDir}`);
  L.push(`OutputBaseFilename=${baseName}`);
  // CEF is the bulk of the installer. Normal compression plus two independent
  // LZMA2 blocks is substantially faster on CI with a modest size tradeoff.
  L.push("Compression=lzma2/normal");
  L.push("LZMANumBlockThreads=2");
  L.push("SolidCompression=yes");
  L.push("ArchitecturesAllowed=x64compatible");
  L.push("ArchitecturesInstallIn64BitMode=x64compatible");
  L.push(`UninstallDisplayIcon={app}\\${exeName}`);
  if (icon) L.push(`SetupIconFile=${icon}`);
  if (license) L.push(`LicenseFile=${license}`);
  if (minimal) {
    L.push("DisableWelcomePage=yes");
    L.push("DisableReadyPage=yes");
  }
  if (!changeDir) L.push("DisableDirPage=yes");
  if (!startMenu) L.push("DisableProgramGroupPage=yes");
  if (options.include) L.push("", "; --- user include ---", options.include, "");

  L.push("", "[Files]");
  L.push(
    `Source: "${appDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
  );

  if (desktop) {
    L.push("", "[Tasks]");
    L.push(
      `Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional:"`,
    );
  }

  L.push("", "[Icons]");
  if (startMenu) L.push(`Name: "{group}\\${v(appName)}"; Filename: "{app}\\${exeName}"`);
  if (desktop) {
    L.push(
      `Name: "{autodesktop}\\${v(appName)}"; Filename: "{app}\\${exeName}"; Tasks: desktopicon`,
    );
  }

  if (runAfter) {
    L.push("", "[Run]");
    L.push(
      `Filename: "{app}\\${exeName}"; Description: "Launch ${v(appName)}"; ` +
        "Flags: nowait postinstall skipifsilent",
    );
  }

  const script = join(outDir, "_installer.iss");
  writeFileSync(script, L.join("\n") + "\n");
  console.log(`[mirin release] compiling Inno Setup installer → ${fileName}`);
  const res = await $`iscc /Q ${script}`.nothrow();
  rmSync(script, { force: true });
  rmSync(join(outDir, "_inno.ico"), { force: true });
  if (res.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`iscc failed (exit ${res.exitCode})`);
  }
  return out;
}
