/**
 * Windows installer (NSIS) for `mirin release` — the Windows analogue of `dmg.ts`.
 *
 * Generates an NSIS script from the app folder + config and compiles it with
 * `makensis` into a single `…-setup.exe`. The installer copies the app into
 * Program Files (per-machine) or `%LOCALAPPDATA%\Programs` (per-user, the
 * default — no elevation, and the in-app updater can swap the folder), creates
 * Start Menu + Desktop shortcuts, writes an uninstaller, and registers an
 * Add/Remove Programs entry. Customizable via {@link NsisConfig}.
 *
 * Requires `makensis` (NSIS 3+) on PATH; the caller checks `hasMakensis()` and
 * falls back to the portable `.zip` when it's absent.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { $ } from "bun";
import type { NsisConfig } from "mirinjs";
import { makeWindowsIcon } from "./icons/windows/index.ts";

export interface BuildNsisInput {
  /** The assembled app folder (build/<App>). */
  appDir: string;
  appName: string;
  /** Host exe name inside the folder (<App>.exe). */
  exeName: string;
  version: string;
  /** Reverse-DNS app id → the Add/Remove Programs registry key. */
  bundleId: string;
  /** Output directory (build/release). */
  outDir: string;
  /** Output file name (e.g. stable-win32-x64-Anko-setup.exe). */
  fileName: string;
  options: NsisConfig;
  /** Project root, for resolving a relative license / installerIcon. */
  projectDir: string;
}

/** Whether `makensis` is on PATH. */
export async function hasMakensis(): Promise<boolean> {
  return (await $`makensis -VERSION`.quiet().nothrow()).exitCode === 0;
}

/** NSIS double-quoted string escaping (`"` and `$` are special). */
function nsis(s: string): string {
  return s.replace(/\$/g, "$$$$").replace(/"/g, '$\\"');
}

const resolve = (projectDir: string, p: string) => (isAbsolute(p) ? p : join(projectDir, p));

/** Build the installer with `makensis`, returning the setup.exe path. */
export async function buildNsisInstaller(input: BuildNsisInput): Promise<string> {
  const { appDir, appName, exeName, version, bundleId, outDir, fileName, options, projectDir } =
    input;
  const out = join(outDir, fileName);
  rmSync(out, { force: true });

  const perMachine = options.perMachine === true;
  const assisted = options.oneClick !== true;
  const desktop = options.desktopShortcut !== false;
  const startMenu = options.startMenuShortcut !== false;
  const runAfter = options.runAfterFinish !== false;
  const changeDir = options.allowChangeInstallDir !== false;
  const publisher = options.publisher ?? appName;
  const root = perMachine ? "HKLM" : "HKCU";
  const installDir =
    options.installDir ??
    (perMachine ? `$PROGRAMFILES64\\${appName}` : `$LOCALAPPDATA\\Programs\\${appName}`);

  // Installer/uninstaller icon: an explicit .ico, else the app's bundled icon.ico.
  let icon: string | undefined;
  if (options.installerIcon) {
    icon = makeWindowsIcon(
      resolve(projectDir, options.installerIcon),
      join(outDir, "_installer.ico"),
    );
  } else if (existsSync(join(appDir, "icon.ico"))) {
    icon = join(appDir, "icon.ico");
  }

  const license = options.license ? resolve(projectDir, options.license) : undefined;
  if (license && !existsSync(license)) throw new Error(`nsis: license not found: ${license}`);

  const L: string[] = [];
  L.push("Unicode True");
  L.push("SetCompressor /SOLID lzma");
  L.push('!include "MUI2.nsh"');
  L.push('!include "FileFunc.nsh"');
  L.push(`Name "${nsis(appName)}"`);
  L.push(`OutFile "${nsis(out)}"`);
  L.push(`InstallDir "${installDir}"`);
  L.push(`RequestExecutionLevel ${perMachine ? "admin" : "user"}`);
  L.push("!define MUI_ABORTWARNING");
  if (icon) {
    L.push(`!define MUI_ICON "${nsis(icon)}"`);
    L.push(`!define MUI_UNICON "${nsis(icon)}"`);
  }

  // Pages. Assisted shows the full wizard; one-click is just the progress page.
  if (assisted) L.push("!insertmacro MUI_PAGE_WELCOME");
  if (license) L.push(`!insertmacro MUI_PAGE_LICENSE "${nsis(license)}"`);
  if (assisted && changeDir) L.push("!insertmacro MUI_PAGE_DIRECTORY");
  if (assisted && runAfter) {
    L.push(`!define MUI_FINISHPAGE_RUN "$INSTDIR\\${nsis(exeName)}"`);
  }
  L.push("!insertmacro MUI_PAGE_INSTFILES");
  if (assisted) L.push("!insertmacro MUI_PAGE_FINISH");
  L.push("!insertmacro MUI_UNPAGE_CONFIRM");
  L.push("!insertmacro MUI_UNPAGE_INSTFILES");
  L.push('!insertmacro MUI_LANGUAGE "English"');

  if (options.include) L.push("", "; --- user include ---", options.include, "");

  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${bundleId}`;
  const ctx = perMachine ? "all" : "current";

  // Install section.
  L.push("Section");
  L.push(`  SetShellVarContext ${ctx}`);
  L.push(`  SetOutPath "$INSTDIR"`);
  L.push(`  File /r "${nsis(appDir)}\\*"`);
  L.push(`  WriteUninstaller "$INSTDIR\\Uninstall.exe"`);
  if (desktop) {
    L.push(`  CreateShortcut "$DESKTOP\\${nsis(appName)}.lnk" "$INSTDIR\\${nsis(exeName)}"`);
  }
  if (startMenu) {
    L.push(`  CreateDirectory "$SMPROGRAMS\\${nsis(appName)}"`);
    L.push(
      `  CreateShortcut "$SMPROGRAMS\\${nsis(appName)}\\${nsis(appName)}.lnk" "$INSTDIR\\${nsis(exeName)}"`,
    );
  }
  // Estimated size for Add/Remove Programs.
  L.push(`  \${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2`);
  L.push(`  IntFmt $0 "0x%08X" $0`);
  const reg = (name: string, val: string) =>
    L.push(`  WriteRegStr ${root} "${key}" "${name}" "${val}"`);
  reg("DisplayName", nsis(appName));
  reg("DisplayVersion", nsis(version));
  reg("Publisher", nsis(publisher));
  reg("DisplayIcon", `$INSTDIR\\${nsis(exeName)}`);
  reg("InstallLocation", "$INSTDIR");
  reg("UninstallString", "$INSTDIR\\Uninstall.exe");
  reg("QuietUninstallString", "$INSTDIR\\Uninstall.exe /S");
  L.push(`  WriteRegDWORD ${root} "${key}" "NoModify" 1`);
  L.push(`  WriteRegDWORD ${root} "${key}" "NoRepair" 1`);
  L.push(`  WriteRegDWORD ${root} "${key}" "EstimatedSize" $0`);
  if (!assisted && runAfter) L.push(`  Exec '"$INSTDIR\\${nsis(exeName)}"'`);
  L.push("SectionEnd");

  // Uninstall section.
  L.push('Section "Uninstall"');
  L.push(`  SetShellVarContext ${ctx}`);
  if (desktop) L.push(`  Delete "$DESKTOP\\${nsis(appName)}.lnk"`);
  if (startMenu) {
    L.push(`  Delete "$SMPROGRAMS\\${nsis(appName)}\\${nsis(appName)}.lnk"`);
    L.push(`  RMDir "$SMPROGRAMS\\${nsis(appName)}"`);
  }
  L.push(`  RMDir /r "$INSTDIR"`);
  L.push(`  DeleteRegKey ${root} "${key}"`);
  L.push("SectionEnd");

  const script = join(outDir, "_installer.nsi");
  writeFileSync(script, L.join("\n") + "\n");
  console.log(`[mirin release] compiling NSIS installer → ${fileName}`);
  const res = await $`makensis -V2 ${script}`.nothrow();
  rmSync(script, { force: true });
  rmSync(join(outDir, "_installer.ico"), { force: true });
  if (res.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`makensis failed (exit ${res.exitCode})`);
  }
  return out;
}
