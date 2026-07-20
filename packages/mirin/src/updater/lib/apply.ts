import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionInfo } from "../types.ts";
import { removePathBestEffort } from "./cleanup.ts";
import { IS_LINUX, IS_WINDOWS, psq, sh } from "./platform.ts";

interface ApplyOptions {
  resourcesDir: string;
  staged: string;
  workDir: string;
  version: VersionInfo;
}

interface ShellScriptOptions {
  runningApp: string;
  staged: string;
  workDir: string;
  pid?: number;
}

interface WindowsScriptOptions extends ShellScriptOptions {
  executable: string;
  backup: string;
  helperFiles: string[];
}

export function renderWindowsLaunchVbs(applyVbs: string): string {
  const command = `wscript.exe //B //Nologo "${applyVbs}"`.replace(/"/g, '""');
  return [
    "Dim status, pid",
    `status = GetObject("winmgmts:Win32_Process").Create("${command}", Null, Null, pid)`,
    "If status <> 0 Then WScript.Quit status",
    "WScript.Quit 0",
    "",
  ].join("\r\n");
}

export function renderWindowsApplyPowerShell(options: WindowsScriptOptions): string {
  const pid = options.pid ?? process.pid;
  const helperFiles = options.helperFiles.map(psq).join(",");
  return [
    "$ErrorActionPreference='Stop'",
    "Set-Location $env:TEMP",
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }`,
    "Start-Sleep -Milliseconds 700",
    `Remove-Item -Recurse -Force ${psq(options.backup)} -ErrorAction SilentlyContinue`,
    `for ($i=0; $i -lt 50; $i++) { Move-Item ${psq(options.runningApp)} ${psq(options.backup)} -ErrorAction SilentlyContinue; if (Test-Path ${psq(options.backup)}) { break }; Start-Sleep -Milliseconds 200 }`,
    `if (-not (Test-Path ${psq(options.backup)})) { throw 'Could not unlock the existing app' }`,
    "try {",
    `  Move-Item ${psq(options.staged)} ${psq(options.runningApp)}`,
    "} catch {",
    `  Move-Item ${psq(options.backup)} ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    "  throw",
    "}",
    "try {",
    `  Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)}`,
    "} catch {",
    `  Remove-Item -Recurse -Force ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  Move-Item ${psq(options.backup)} ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    "  throw",
    "}",
    `Remove-Item -Recurse -Force ${psq(options.backup)} -ErrorAction SilentlyContinue`,
    `Remove-Item -Recurse -Force ${psq(options.workDir)} -ErrorAction SilentlyContinue`,
    `Remove-Item -Force ${helperFiles} -ErrorAction SilentlyContinue`,
  ].join("\n");
}

export function renderLinuxApplyShell(
  options: ShellScriptOptions & { executable: string },
): string {
  return [
    ...shellPrelude(options),
    'rm -rf "$OLD"',
    'mv "$APP" "$OLD"',
    'if ! mv "$NEW" "$APP"; then',
    '  mv "$OLD" "$APP"',
    "  exit 1",
    "fi",
    `setsid ${sh(options.executable)} >/dev/null 2>&1 < /dev/null &`,
    'rm -rf "$OLD"',
    'rm -rf "$WORK"',
  ].join("\n");
}

export function renderMacApplyShell(options: ShellScriptOptions): string {
  return [
    ...shellPrelude(options),
    'rm -rf "$OLD"',
    'mv "$APP" "$OLD"',
    'if ! mv "$NEW" "$APP"; then',
    '  mv "$OLD" "$APP"',
    "  exit 1",
    "fi",
    'xattr -r -d com.apple.quarantine "$APP" 2>/dev/null || true',
    'if open "$APP"; then',
    '  rm -rf "$OLD"',
    '  rm -rf "$WORK"',
    "else",
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  open "$APP" || true',
    "  exit 1",
    "fi",
  ].join("\n");
}

/** Start a detached platform helper that swaps the app after this process exits. */
export async function applyUpdateAndRelaunch(options: ApplyOptions): Promise<void> {
  if (IS_WINDOWS) return applyWindows(options);
  if (IS_LINUX) {
    applyLinux(options);
    return;
  }
  applyMac(options);
}

async function applyWindows({
  resourcesDir,
  staged,
  workDir,
  version,
}: ApplyOptions): Promise<void> {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, `${version.name}.exe`);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const script = join(tmpdir(), `mirin-apply-${token}.ps1`);
  const applyVbs = join(tmpdir(), `mirin-apply-${token}.vbs`);
  const launchVbs = join(tmpdir(), `mirin-launch-${token}.vbs`);
  const helperFiles = [script, applyVbs, launchVbs];
  const backup = `${runningApp}.mirin-old-${process.pid}`;
  writeFileSync(
    script,
    renderWindowsApplyPowerShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      helperFiles,
    }),
    "utf8",
  );
  writeFileSync(
    applyVbs,
    `CreateObject("WScript.Shell").Run "powershell -NoProfile -NonInteractive ` +
      `-ExecutionPolicy Bypass -WindowStyle Hidden -File ""${script}""", 0, False\n`,
    "utf8",
  );
  writeFileSync(launchVbs, renderWindowsLaunchVbs(applyVbs), "utf8");

  try {
    const launcher = Bun.spawn(["wscript.exe", "//B", "//Nologo", launchVbs], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await launcher.exited;
    if (exitCode !== 0) {
      throw new Error(`failed to launch Windows updater via WMI (${exitCode})`);
    }
  } catch (error) {
    for (const file of helperFiles) removePathBestEffort(file);
    throw error;
  }
}

function applyLinux({ resourcesDir, staged, workDir, version }: ApplyOptions): void {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, version.name);
  spawnShellSwap(renderLinuxApplyShell({ runningApp, staged, workDir, executable }));
}

function applyMac({ resourcesDir, staged, workDir }: ApplyOptions): void {
  const runningApp = join(resourcesDir, "..", "..");
  spawnShellSwap(renderMacApplyShell({ runningApp, staged, workDir }));
}

function shellPrelude(options: ShellScriptOptions): string[] {
  return [
    "set -eu",
    `APP=${sh(options.runningApp)}`,
    `NEW=${sh(options.staged)}`,
    `WORK=${sh(options.workDir)}`,
    `PID=${options.pid ?? process.pid}`,
    'OLD="$APP.mirin-old-$PID"',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    "sleep 0.3",
  ];
}

function spawnShellSwap(script: string): void {
  Bun.spawn(["/bin/sh", "-c", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}
