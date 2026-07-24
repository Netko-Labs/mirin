import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionInfo } from "../types.ts";
import { APPLY_HELPER_PID_FILE, removePathBestEffort } from "./cleanup.ts";
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
  backup?: string;
}

interface WindowsScriptOptions extends ShellScriptOptions {
  executable: string;
  backup: string;
  helperFiles: string[];
}

export function renderWindowsLaunchVbs(powershellScript: string, helperPidFile?: string): string {
  const command =
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
    `-WindowStyle Hidden -File "${powershellScript}"`;
  const escapedCommand = command.replace(/"/g, '""');
  const lines = [
    "Dim status, pid",
    `status = GetObject("winmgmts:Win32_Process").Create("${escapedCommand}", Null, Null, pid)`,
    "If status <> 0 Then WScript.Quit status",
  ];
  if (helperPidFile) {
    const path = helperPidFile.replace(/"/g, '""');
    lines.push(
      "On Error Resume Next",
      "Dim pidFile",
      `Set pidFile = CreateObject("Scripting.FileSystemObject").CreateTextFile("${path}", False)`,
      "If Err.Number <> 0 Then",
      `  GetObject("winmgmts:Win32_Process.Handle='" & CStr(pid) & "'").Terminate`,
      "  WScript.Quit 1",
      "End If",
      "pidFile.Write CStr(pid)",
      "pidFile.Close",
      "If Err.Number <> 0 Then",
      `  GetObject("winmgmts:Win32_Process.Handle='" & CStr(pid) & "'").Terminate`,
      "  WScript.Quit 1",
      "End If",
      "On Error GoTo 0",
    );
  }
  lines.push("WScript.Quit 0", "");
  return lines.join("\r\n");
}

export function renderWindowsApplyPowerShell(options: WindowsScriptOptions): string {
  const pid = options.pid ?? process.pid;
  const helperFiles = options.helperFiles.map(psq).join(",");
  return [
    "$ErrorActionPreference='Stop'",
    "Set-Location $env:TEMP",
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }`,
    "Start-Sleep -Milliseconds 700",
    `if (Test-Path ${psq(options.backup)}) { throw 'Updater backup path already exists' }`,
    `for ($i=0; $i -lt 50; $i++) { try { Move-Item ${psq(options.runningApp)} ${psq(options.backup)} -ErrorAction Stop } catch {}; if ((Test-Path ${psq(options.backup)}) -and -not (Test-Path ${psq(options.runningApp)})) { break }; Start-Sleep -Milliseconds 200 }`,
    `if ((Test-Path ${psq(options.runningApp)}) -or -not (Test-Path ${psq(options.backup)})) { throw 'Could not unlock the existing app' }`,
    "try {",
    `  Move-Item ${psq(options.staged)} ${psq(options.runningApp)}`,
    "} catch {",
    `  Remove-Item -Recurse -Force ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  Move-Item ${psq(options.backup)} ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  if (-not (Test-Path ${psq(options.executable)})) { throw 'Update rollback failed' }`,
    "  throw",
    "}",
    "try {",
    `  Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)}`,
    "} catch {",
    `  Remove-Item -Recurse -Force ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  Move-Item ${psq(options.backup)} ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  if (-not (Test-Path ${psq(options.executable)})) { throw 'Update rollback failed' }`,
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
    `EXE=${sh(options.executable)}`,
    'mv "$APP" "$OLD"',
    'if ! mv "$NEW" "$APP"; then',
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -x "$EXE"',
    "  exit 1",
    "fi",
    "if ! command -v setsid >/dev/null 2>&1; then",
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -x "$EXE"',
    "  exit 1",
    "fi",
    'setsid "$EXE" >/dev/null 2>&1 < /dev/null &',
    "NEW_PID=$!",
    "sleep 1",
    'if ! kill -0 "$NEW_PID" 2>/dev/null; then',
    '  wait "$NEW_PID" 2>/dev/null || true',
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -x "$EXE"',
    '  setsid "$EXE" >/dev/null 2>&1 < /dev/null &',
    "  exit 1",
    "fi",
    'rm -rf "$OLD"',
    'rm -rf "$WORK"',
  ].join("\n");
}

export function renderMacApplyShell(options: ShellScriptOptions): string {
  return [
    ...shellPrelude(options),
    'mv "$APP" "$OLD"',
    'if ! mv "$NEW" "$APP"; then',
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -d "$APP"',
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
  const launchVbs = join(tmpdir(), `mirin-launch-${token}.vbs`);
  const helperFiles = [script, launchVbs];
  const backup = `${runningApp}.mirin-old-${token}`;
  const helperPidFile = join(workDir, APPLY_HELPER_PID_FILE);
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
  writeFileSync(launchVbs, renderWindowsLaunchVbs(script, helperPidFile), "utf8");

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
  const backup = `${runningApp}.mirin-old-${process.pid}-${crypto.randomUUID()}`;
  spawnShellSwap(
    renderLinuxApplyShell({ runningApp, staged, workDir, executable, backup }),
    workDir,
  );
}

function applyMac({ resourcesDir, staged, workDir }: ApplyOptions): void {
  const runningApp = join(resourcesDir, "..", "..");
  const backup = `${runningApp}.mirin-old-${process.pid}-${crypto.randomUUID()}`;
  spawnShellSwap(renderMacApplyShell({ runningApp, staged, workDir, backup }), workDir);
}

function shellPrelude(options: ShellScriptOptions): string[] {
  return [
    "set -eu",
    `APP=${sh(options.runningApp)}`,
    `NEW=${sh(options.staged)}`,
    `WORK=${sh(options.workDir)}`,
    `PID=${options.pid ?? process.pid}`,
    `OLD=${sh(options.backup ?? `${options.runningApp}.mirin-old-${options.pid ?? process.pid}`)}`,
    'if [ -e "$OLD" ]; then exit 1; fi',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    "sleep 0.3",
  ];
}

function spawnShellSwap(script: string, workDir: string): void {
  const helper = Bun.spawn(["/bin/sh", "-c", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    writeFileSync(join(workDir, APPLY_HELPER_PID_FILE), String(helper.pid), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    helper.kill();
    throw error;
  }
  helper.unref();
}
