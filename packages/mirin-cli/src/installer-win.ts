/**
 * Windows installer (NSIS) for `mirin release` — the Windows analogue of `dmg.ts`.
 * The app payload is owned under `$INSTDIR\app`; the stable root contains only the
 * uninstaller so removal never recursively deletes unrelated user files.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { $ } from "bun";
import type { NsisConfig } from "mirinjs";
import { makeWindowsIcon } from "./icons/windows/index.ts";
import { validateAppIdentity } from "./shared/validation/config.ts";

export interface BuildNsisInput {
  /** The assembled app folder (build/<App>). */
  appDir: string;
  appName: string;
  /** Host exe name inside the folder (<App>.exe). */
  exeName: string;
  version: string;
  channel: string;
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

export interface RenderNsisInput extends BuildNsisInput {
  out: string;
  icon?: string;
  license?: string;
}

/** Whether `makensis` is on PATH. */
export async function hasMakensis(): Promise<boolean> {
  return (await $`makensis -VERSION`.quiet().nothrow()).exitCode === 0;
}

const resolve = (projectDir: string, path: string): string =>
  isAbsolute(path) ? path : join(projectDir, path);

/** Render a complete NSIS script without touching the filesystem. */
export function renderNsisScript(input: RenderNsisInput): string {
  const { appName, bundleId, version } = validateAppIdentity({
    appName: input.appName,
    bundleId: input.bundleId,
    version: input.version,
    channel: input.channel,
  });
  validateInstallerFileName(input.fileName);
  const { appDir, exeName, options, out, icon, license } = input;
  if (exeName !== `${appName}.exe`) {
    throw new Error(`nsis: exeName must be ${appName}.exe`);
  }
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
  validateNsisInstallDir(installDir);

  const lines: string[] = [];
  lines.push("Unicode True");
  lines.push("SetCompressor /SOLID lzma");
  lines.push('!include "MUI2.nsh"');
  lines.push('!include "FileFunc.nsh"');
  lines.push(`Name "${nsisLiteral(appName)}"`);
  lines.push(`OutFile "${nsisLiteral(out)}"`);
  lines.push(`InstallDir "${installDir}"`);
  lines.push(`RequestExecutionLevel ${perMachine ? "admin" : "user"}`);
  lines.push("!define MUI_ABORTWARNING");
  if (icon) {
    lines.push(`!define MUI_ICON "${nsisLiteral(icon)}"`);
    lines.push(`!define MUI_UNICON "${nsisLiteral(icon)}"`);
  }

  if (assisted) lines.push("!insertmacro MUI_PAGE_WELCOME");
  if (license) lines.push(`!insertmacro MUI_PAGE_LICENSE "${nsisLiteral(license)}"`);
  if (assisted && changeDir) lines.push("!insertmacro MUI_PAGE_DIRECTORY");
  if (assisted && runAfter) {
    lines.push(`!define MUI_FINISHPAGE_RUN "$INSTDIR\\app\\${nsisLiteral(exeName)}"`);
  }
  lines.push("!insertmacro MUI_PAGE_INSTFILES");
  if (assisted) lines.push("!insertmacro MUI_PAGE_FINISH");
  lines.push("!insertmacro MUI_UNPAGE_CONFIRM");
  lines.push("!insertmacro MUI_UNPAGE_INSTFILES");
  lines.push('!insertmacro MUI_LANGUAGE "English"');

  // `include` is deliberately raw: the public config documents it as an advanced
  // NSIS extension point. Every structured value around it is escaped or validated.
  if (options.include) lines.push("", "; --- user include ---", options.include, "");

  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${bundleId}`;
  const context = perMachine ? "all" : "current";
  const appExe = `$INSTDIR\\app\\${nsisLiteral(exeName)}`;

  lines.push("Section");
  lines.push(`  SetShellVarContext ${context}`);
  lines.push('  SetOutPath "$INSTDIR\\app"');
  lines.push(`  File /r "${nsisLiteral(appDir)}\\*"`);
  lines.push('  WriteUninstaller "$INSTDIR\\Uninstall.exe"');
  if (desktop) {
    lines.push(`  CreateShortcut "$DESKTOP\\${nsisLiteral(appName)}.lnk" "${appExe}"`);
  }
  if (startMenu) {
    lines.push(`  CreateDirectory "$SMPROGRAMS\\${nsisLiteral(appName)}"`);
    lines.push(
      `  CreateShortcut "$SMPROGRAMS\\${nsisLiteral(appName)}\\${nsisLiteral(appName)}.lnk" "${appExe}"`,
    );
  }
  lines.push(`  \${GetSize} "$INSTDIR\\app" "/S=0K" $0 $1 $2`);
  lines.push('  IntFmt $0 "0x%08X" $0');
  const registryString = (name: string, value: string): void => {
    lines.push(`  WriteRegStr ${root} "${key}" "${name}" "${value}"`);
  };
  registryString("DisplayName", nsisLiteral(appName));
  registryString("DisplayVersion", nsisLiteral(version));
  registryString("Publisher", nsisLiteral(publisher));
  registryString("DisplayIcon", appExe);
  registryString("InstallLocation", "$INSTDIR");
  lines.push(`  WriteRegStr ${root} "${key}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'`);
  lines.push(
    `  WriteRegStr ${root} "${key}" "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'`,
  );
  lines.push(`  WriteRegDWORD ${root} "${key}" "NoModify" 1`);
  lines.push(`  WriteRegDWORD ${root} "${key}" "NoRepair" 1`);
  lines.push(`  WriteRegDWORD ${root} "${key}" "EstimatedSize" $0`);
  if (!assisted && runAfter) lines.push(`  Exec '"${appExe}"'`);
  lines.push("SectionEnd");

  lines.push('Section "Uninstall"');
  lines.push(`  SetShellVarContext ${context}`);
  if (desktop) lines.push(`  Delete "$DESKTOP\\${nsisLiteral(appName)}.lnk"`);
  if (startMenu) {
    lines.push(`  Delete "$SMPROGRAMS\\${nsisLiteral(appName)}\\${nsisLiteral(appName)}.lnk"`);
    lines.push(`  RMDir "$SMPROGRAMS\\${nsisLiteral(appName)}"`);
  }
  lines.push('  RMDir /r "$INSTDIR\\app"');
  lines.push('  Delete "$INSTDIR\\Uninstall.exe"');
  lines.push(`  DeleteRegKey ${root} "${key}"`);
  lines.push('  RMDir "$INSTDIR"');
  lines.push("SectionEnd");

  return `${lines.join("\n")}\n`;
}

/** Build the installer with `makensis`, returning the setup.exe path. */
export async function buildNsisInstaller(input: BuildNsisInput): Promise<string> {
  const { appName } = validateAppIdentity({
    appName: input.appName,
    bundleId: input.bundleId,
    version: input.version,
    channel: input.channel,
  });
  validateInstallerFileName(input.fileName);
  if (input.exeName !== `${appName}.exe`) {
    throw new Error(`nsis: exeName must be ${appName}.exe`);
  }
  const out = join(input.outDir, input.fileName);
  rmSync(out, { force: true });

  let icon: string | undefined;
  if (input.options.installerIcon) {
    icon = makeWindowsIcon(
      resolve(input.projectDir, input.options.installerIcon),
      join(input.outDir, "_installer.ico"),
    );
  } else if (existsSync(join(input.appDir, "icon.ico"))) {
    icon = join(input.appDir, "icon.ico");
  }

  const license = input.options.license
    ? resolve(input.projectDir, input.options.license)
    : undefined;
  if (license && !existsSync(license)) throw new Error(`nsis: license not found: ${license}`);

  const script = join(input.outDir, "_installer.nsi");
  writeFileSync(script, renderNsisScript({ ...input, out, icon, license }));
  console.log(`[mirin release] compiling NSIS installer → ${input.fileName}`);
  const result = await $`makensis -V2 ${script}`.nothrow();
  rmSync(script, { force: true });
  rmSync(join(input.outDir, "_installer.ico"), { force: true });
  if (result.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`makensis failed (exit ${result.exitCode})`);
  }
  return out;
}

function nsisLiteral(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("nsis: structured values cannot contain control characters");
  }
  return value.replace(/\$/g, "$$$$").replace(/"/g, '$\\"');
}

function validateNsisInstallDir(value: string): void {
  const withoutVariables = value.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "");
  if (
    value.length === 0 ||
    value.length > 1024 ||
    /[\0\r\n"]/.test(value) ||
    withoutVariables.includes("$") ||
    !/^(?:[A-Za-z]:[\\/]|\\\\|\$[A-Za-z_])/.test(value)
  ) {
    throw new Error(
      "nsis: installDir must be an absolute Windows path or start with an NSIS variable",
    );
  }
}

function validateInstallerFileName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(value)
  ) {
    throw new Error("nsis: fileName must be a flat portable .exe name");
  }
}
