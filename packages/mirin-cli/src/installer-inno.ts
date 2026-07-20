/**
 * Windows installer via Inno Setup. Structured config values are validated or
 * escaped; `include` remains the documented raw advanced extension point.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { InnoConfig } from "mirinjs";
import { makeWindowsIcon } from "./icons/windows/index.ts";
import {
  assertProjectFile,
  canonicalProjectRoot,
  resolveProjectFile,
} from "./shared/fs/project-source.ts";
import { validateAppIdentity } from "./shared/validation/config.ts";

export interface BuildInnoInput {
  appDir: string;
  appName: string;
  exeName: string;
  version: string;
  channel: string;
  bundleId: string;
  outDir: string;
  fileName: string;
  options: InnoConfig;
  projectDir: string;
}

export interface RenderInnoInput extends BuildInnoInput {
  icon?: string;
  license?: string;
}

/** Whether the Inno Setup compiler `iscc` is on PATH. */
export function hasInno(): boolean {
  return Bun.which("iscc") != null;
}

/** Render a complete Inno Setup script without touching the filesystem. */
export function renderInnoScript(input: RenderInnoInput): string {
  const { appName, bundleId, version } = validateAppIdentity({
    appName: input.appName,
    bundleId: input.bundleId,
    version: input.version,
    channel: input.channel,
  });
  validateInstallerFileName(input.fileName);
  const { appDir, exeName, outDir, fileName, options, icon, license } = input;
  if (exeName !== `${appName}.exe`) throw new Error(`inno: exeName must be ${appName}.exe`);

  const perMachine = options.perMachine === true;
  const minimal = options.oneClick === true;
  const desktop = options.desktopShortcut !== false;
  const startMenu = options.startMenuShortcut !== false;
  const runAfter = options.runAfterFinish !== false;
  const changeDir = options.allowChangeInstallDir !== false && !minimal;
  const publisher = options.publisher ?? appName;
  const installDir = renderInnoInstallDir(
    options.installDir ??
      (perMachine ? `{autopf}\\${appName}` : `{localappdata}\\Programs\\${appName}`),
  );
  const baseName = fileName.slice(0, -".exe".length);

  const lines: string[] = [];
  lines.push("[Setup]");
  lines.push(`AppId={{${bundleId}}`);
  lines.push(`AppName=${innoLiteral(appName)}`);
  lines.push(`AppVersion=${innoLiteral(version)}`);
  lines.push(`AppVerName=${innoLiteral(appName)}`);
  lines.push(`AppPublisher=${innoLiteral(publisher)}`);
  lines.push("WizardStyle=modern");
  lines.push(`DefaultDirName=${installDir}`);
  lines.push(`DefaultGroupName=${innoLiteral(appName)}`);
  lines.push(`PrivilegesRequired=${perMachine ? "admin" : "lowest"}`);
  lines.push(`OutputDir=${innoLiteralPath(outDir, "output directory")}`);
  lines.push(`OutputBaseFilename=${innoLiteralPath(baseName, "output base filename")}`);
  lines.push("Compression=lzma2/normal");
  lines.push("LZMANumBlockThreads=2");
  lines.push("SolidCompression=yes");
  lines.push("ArchitecturesAllowed=x64compatible");
  lines.push("ArchitecturesInstallIn64BitMode=x64compatible");
  lines.push(`UninstallDisplayIcon={app}\\${innoLiteralPath(exeName, "executable name")}`);
  if (icon) lines.push(`SetupIconFile=${innoLiteralPath(icon, "installer icon")}`);
  if (license) lines.push(`LicenseFile=${innoLiteralPath(license, "license file")}`);
  if (minimal) {
    lines.push("DisableWelcomePage=yes");
    lines.push("DisableReadyPage=yes");
  }
  if (!changeDir) lines.push("DisableDirPage=yes");
  if (!startMenu) lines.push("DisableProgramGroupPage=yes");
  if (options.include) lines.push("", "; --- user include ---", options.include, "");

  lines.push("", "[Files]");
  lines.push(
    `Source: "${innoQuotedPath(appDir, "app directory")}\\*"; ` +
      'DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs',
  );

  if (desktop) {
    lines.push("", "[Tasks]");
    lines.push(
      'Name: "desktopicon"; Description: "Create a desktop shortcut"; ' +
        'GroupDescription: "Additional:"',
    );
  }

  lines.push("", "[Icons]");
  if (startMenu) {
    lines.push(
      `Name: "{group}\\${innoQuoted(appName)}"; ` + `Filename: "{app}\\${innoQuoted(exeName)}"`,
    );
  }
  if (desktop) {
    lines.push(
      `Name: "{autodesktop}\\${innoQuoted(appName)}"; ` +
        `Filename: "{app}\\${innoQuoted(exeName)}"; Tasks: desktopicon`,
    );
  }

  if (runAfter) {
    lines.push("", "[Run]");
    lines.push(
      `Filename: "{app}\\${innoQuoted(exeName)}"; ` +
        `Description: "Launch ${innoQuoted(appName)}"; Flags: nowait postinstall skipifsilent`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Build the installer with `iscc`, returning the setup.exe path. */
export async function buildInnoInstaller(input: BuildInnoInput): Promise<string> {
  const { appName } = validateAppIdentity({
    appName: input.appName,
    bundleId: input.bundleId,
    version: input.version,
    channel: input.channel,
  });
  validateInstallerFileName(input.fileName);
  if (input.exeName !== `${appName}.exe`) {
    throw new Error(`inno: exeName must be ${appName}.exe`);
  }
  const root = canonicalProjectRoot(input.projectDir);

  let icon: string | undefined;
  if (input.options.installerIcon) {
    const source = resolveProjectFile(root, input.options.installerIcon, "Inno installer icon");
    icon = makeWindowsIcon(
      assertProjectFile(root, source, "Inno installer icon"),
      join(input.outDir, "_inno.ico"),
    );
  } else if (existsSync(join(input.appDir, "icon.ico"))) {
    icon = join(input.appDir, "icon.ico");
  }
  const license = input.options.license
    ? assertProjectFile(
        root,
        resolveProjectFile(root, input.options.license, "Inno license"),
        "Inno license",
      )
    : undefined;

  const rendered = renderInnoScript({ ...input, icon, license });
  const out = join(input.outDir, input.fileName);
  rmSync(out, { force: true });
  const script = join(input.outDir, "_installer.iss");
  writeFileSync(script, rendered);
  console.log(`[mirin release] compiling Inno Setup installer → ${input.fileName}`);
  const result = await $`iscc /Q ${script}`.nothrow();
  rmSync(script, { force: true });
  rmSync(join(input.outDir, "_inno.ico"), { force: true });
  if (result.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`iscc failed (exit ${result.exitCode})`);
  }
  return out;
}

function renderInnoInstallDir(value: string): string {
  if (value.length === 0 || value.length > 1024 || /[\0\r\n"]/.test(value)) {
    throw new Error(
      "inno: installDir must be an absolute Windows path or start with {autopf} or {localappdata}",
    );
  }

  const constant = value.match(/^(\{(?:autopf|localappdata)\})(?=$|[\\/])/i);
  if (constant) {
    const prefix = constant[1];
    if (prefix === undefined) throw new Error("inno: invalid installDir constant");
    return `${prefix}${innoLiteralPath(value.slice(prefix.length), "install directory")}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)) {
    return innoLiteralPath(value, "install directory");
  }
  throw new Error(
    "inno: installDir must be an absolute Windows path or start with {autopf} or {localappdata}",
  );
}

function innoLiteral(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("inno: structured values cannot contain control characters");
  }
  return value.replace(/\{/g, "{{");
}

function innoQuoted(value: string): string {
  return innoLiteral(value).replace(/"/g, '""');
}

function innoLiteralPath(value: string, label: string): string {
  if (value.length === 0 || /[\0\r\n"]/.test(value)) {
    throw new Error(`inno: ${label} contains invalid characters`);
  }
  return value.replace(/\{/g, "{{");
}

function innoQuotedPath(value: string, label: string): string {
  return innoLiteralPath(value, label).replace(/"/g, '""');
}

function validateInstallerFileName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(value)
  ) {
    throw new Error("inno: fileName must be a flat portable .exe name");
  }
}
