/**
 * Windows installer (NSIS) for `mirin release` — the Windows analogue of `dmg.ts`.
 * The app payload is owned under `$INSTDIR\app`; the stable root contains only the
 * uninstaller so removal never recursively deletes unrelated user files.
 */

import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { NsisConfig } from "mirinjs";
import { makeWindowsIcon } from "./icons/windows/index.ts";
import {
  assertProjectFile,
  canonicalProjectRoot,
  resolveProjectFile,
} from "./shared/fs/project-source.ts";
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
  /** Additional flat payload files owned by this build and safe to remove from legacy installs. */
  legacyRootFiles?: readonly string[];
}

const LEGACY_CEF_ROOT_FILES = [
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "icudtl.dat",
  "libcef.dll",
  "libEGL.dll",
  "libGLESv2.dll",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
] as const;

/** Whether `makensis` is on PATH. */
export async function hasMakensis(): Promise<boolean> {
  return (await $`makensis -VERSION`.quiet().nothrow()).exitCode === 0;
}

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
  const ownershipMarker = `.mirin-${bundleId}.owned`;
  const legacyRootFiles = normalizedLegacyRootFiles(exeName, input.legacyRootFiles);
  appendLegacyCleanupFunction(lines, {
    name: "CleanupLegacyFlatPayload",
    exeName,
    bundleId,
    rootFiles: legacyRootFiles,
    deleteNsisUninstaller: true,
  });
  appendOwnedNestedCleanupFunction(lines, {
    name: "CleanupOwnedNestedInstall",
    ownershipMarker,
    bundleId,
  });
  appendLegacyCleanupFunction(lines, {
    name: "un.CleanupLegacyFlatPayload",
    exeName,
    bundleId,
    rootFiles: legacyRootFiles,
    deleteNsisUninstaller: false,
  });

  lines.push("Section");
  lines.push(`  SetShellVarContext ${context}`);
  lines.push("  Call CleanupLegacyFlatPayload");
  lines.push("  Call RequireOwnedNestedOrEmpty");
  lines.push('  CreateDirectory "$INSTDIR"');
  lines.push("  ClearErrors");
  lines.push(`  FileOpen $0 "$INSTDIR\\${nsisLiteral(ownershipMarker)}" w`);
  lines.push("  IfErrors 0 +3");
  lines.push('  MessageBox MB_ICONSTOP "Could not record Mirin installer ownership."');
  lines.push("  Abort");
  lines.push(`  FileWrite $0 "${nsisLiteral(bundleId)}$\\r$\\n"`);
  lines.push("  FileClose $0");
  lines.push("  Call CleanupOwnedNestedInstall");
  lines.push('  RMDir /r "$INSTDIR\\app"');
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
  lines.push("  Call un.CleanupLegacyFlatPayload");
  lines.push(`  IfFileExists "$INSTDIR\\${nsisLiteral(ownershipMarker)}" 0 .payloadDone`);
  lines.push('  RMDir /r "$INSTDIR\\app"');
  lines.push(`  Delete "$INSTDIR\\${nsisLiteral(ownershipMarker)}"`);
  lines.push("  .payloadDone:");
  lines.push('  Delete "$INSTDIR\\Uninstall.exe"');
  lines.push(`  DeleteRegKey ${root} "${key}"`);
  lines.push('  RMDir "$INSTDIR"');
  lines.push("SectionEnd");

  return `${lines.join("\n")}\n`;
}

interface OwnedNestedCleanupOptions {
  name: string;
  ownershipMarker: string;
  bundleId: string;
}

function appendOwnedNestedCleanupFunction(
  lines: string[],
  options: OwnedNestedCleanupOptions,
): void {
  const { name, ownershipMarker, bundleId } = options;
  const innoKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${bundleId}}_is1`;
  lines.push(
    "",
    "Function RequireOwnedNestedOrEmpty",
    '  IfFileExists "$INSTDIR\\app\\*" 0 require_owned_done',
    `  IfFileExists "$INSTDIR\\${nsisLiteral(ownershipMarker)}" require_owned_done 0`,
    '  MessageBox MB_ICONSTOP "The selected install directory already contains an app folder that is not owned by this Mirin application. Choose another directory."',
    "  Abort",
    "require_owned_done:",
    "FunctionEnd",
    "",
    `Function ${name}`,
    `  IfFileExists "$INSTDIR\\${nsisLiteral(ownershipMarker)}" 0 cleanup_owned_done`,
    '  Delete "$INSTDIR\\unins000.exe"',
    '  Delete "$INSTDIR\\unins000.dat"',
    '  Delete "$INSTDIR\\unins000.msg"',
    "  SetRegView 32",
    `  DeleteRegKey HKCU "${innoKey}"`,
    `  DeleteRegKey HKLM "${innoKey}"`,
    "  SetRegView 64",
    `  DeleteRegKey HKCU "${innoKey}"`,
    `  DeleteRegKey HKLM "${innoKey}"`,
    "  SetRegView 32",
    "cleanup_owned_done:",
    "FunctionEnd",
  );
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
  const root = canonicalProjectRoot(input.projectDir);

  let icon: string | undefined;
  if (input.options.installerIcon) {
    const source = resolveProjectFile(root, input.options.installerIcon, "NSIS installer icon");
    icon = makeWindowsIcon(
      assertProjectFile(root, source, "NSIS installer icon"),
      join(input.outDir, "_installer.ico"),
    );
  } else if (existsSync(join(input.appDir, "icon.ico"))) {
    icon = join(input.appDir, "icon.ico");
  }

  const license = input.options.license
    ? assertProjectFile(
        root,
        resolveProjectFile(root, input.options.license, "NSIS license"),
        "NSIS license",
      )
    : undefined;
  const legacyRootFiles = readdirSync(input.appDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const script = join(input.outDir, "_installer.nsi");
  writeFileSync(script, renderNsisScript({ ...input, out, icon, license, legacyRootFiles }));
  console.log(`[mirin release] compiling NSIS installer → ${input.fileName}`);
  const result = await $`makensis -V2 ${script}`.nothrow();
  rmSync(script, { force: true });
  rmSync(join(input.outDir, "_installer.ico"), { force: true });
  if (result.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`makensis failed (exit ${result.exitCode})`);
  }
  return out;
}

interface LegacyCleanupOptions {
  name: string;
  exeName: string;
  bundleId: string;
  rootFiles: readonly string[];
  deleteNsisUninstaller: boolean;
}

function appendLegacyCleanupFunction(lines: string[], options: LegacyCleanupOptions): void {
  const { name, exeName, bundleId, rootFiles, deleteNsisUninstaller } = options;
  const done = `${name.replace(".", "_")}_done`;
  lines.push("", `Function ${name}`);
  for (const marker of [exeName, "mirin_core.dll", "mirin-helper.exe", "libcef.dll"]) {
    lines.push(`  IfFileExists "$INSTDIR\\${nsisLiteral(marker)}" 0 ${done}`);
  }
  lines.push(`  IfFileExists "$INSTDIR\\resources\\mirin.manifest.json" 0 ${done}`);
  lines.push('  RMDir /r "$INSTDIR\\resources"');
  lines.push('  RMDir /r "$INSTDIR\\locales"');
  for (const file of rootFiles) {
    lines.push(`  Delete "$INSTDIR\\${nsisLiteral(file)}"`);
  }
  lines.push('  Delete "$INSTDIR\\unins000.exe"');
  lines.push('  Delete "$INSTDIR\\unins000.dat"');
  lines.push('  Delete "$INSTDIR\\unins000.msg"');
  if (deleteNsisUninstaller) lines.push('  Delete "$INSTDIR\\Uninstall.exe"');
  const innoKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${bundleId}}_is1`;
  lines.push("  SetRegView 32");
  lines.push(`  DeleteRegKey HKCU "${innoKey}"`);
  lines.push(`  DeleteRegKey HKLM "${innoKey}"`);
  lines.push("  SetRegView 64");
  lines.push(`  DeleteRegKey HKCU "${innoKey}"`);
  lines.push(`  DeleteRegKey HKLM "${innoKey}"`);
  lines.push("  SetRegView 32");
  lines.push(`${done}:`);
  lines.push("FunctionEnd");
}

function normalizedLegacyRootFiles(
  exeName: string,
  additionalFiles: readonly string[] | undefined,
): string[] {
  const candidates = [
    exeName,
    "mirin_core.dll",
    "mirin-helper.exe",
    "icon.ico",
    ...LEGACY_CEF_ROOT_FILES,
    ...(additionalFiles ?? []),
  ];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const file of candidates) {
    validateLegacyRootFileName(file);
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  return files;
}

function validateLegacyRootFileName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    value.endsWith(" ") ||
    /[\\/\0\r\n]/.test(value)
  ) {
    throw new Error("nsis: legacy payload entries must be flat portable file names");
  }
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
