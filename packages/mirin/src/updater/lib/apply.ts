import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  abandonUpdateHandoff,
  activateUpdateHandoff,
  type PreparedUpdateHandoff,
  prepareUpdateHandoff,
} from "../../update-handoff.ts";
import type { VersionInfo } from "../types.ts";
import { APPLY_HELPER_PID_FILE, removePathBestEffort } from "./cleanup.ts";
import { IS_LINUX, IS_WINDOWS, psq, sh } from "./platform.ts";

interface ApplyOptions {
  resourcesDir: string;
  staged: string;
  workDir: string;
  version: VersionInfo;
  targetVersion: string;
}

interface ShellScriptOptions {
  runningApp: string;
  staged: string;
  workDir: string;
  marker: string;
  ready: string;
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
    "$parentDeadline=(Get-Date).AddSeconds(30)",
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {`,
    "  if ((Get-Date) -ge $parentDeadline) {",
    `    Remove-Item -Force ${psq(options.marker)},${psq(options.ready)} -ErrorAction SilentlyContinue`,
    "    throw 'Application did not exit for updater handoff'",
    "  }",
    "  Start-Sleep -Milliseconds 200",
    "}",
    `Remove-Item -Force ${psq(options.ready)} -ErrorAction SilentlyContinue`,
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
    "$newProcess=$null",
    "try {",
    `  $newProcess=Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)} -PassThru`,
    "  $readyDeadline=(Get-Date).AddSeconds(30)",
    `  while (-not (Test-Path ${psq(options.ready)})) {`,
    "    $newProcess.Refresh()",
    "    if ($newProcess.HasExited) { throw 'Replacement exited before reporting ready' }",
    "    if ((Get-Date) -ge $readyDeadline) { throw 'Replacement did not report ready' }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  $newProcess.Refresh()",
    "  if ($newProcess.HasExited) { throw 'Replacement exited after reporting ready' }",
    "} catch {",
    "  if ($null -ne $newProcess -and -not $newProcess.HasExited) {",
    "    Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue",
    "    $newProcess.WaitForExit(5000) | Out-Null",
    "  }",
    `  Remove-Item -Recurse -Force ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  Move-Item ${psq(options.backup)} ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    `  if (-not (Test-Path ${psq(options.executable)})) { throw 'Update rollback failed' }`,
    `  Remove-Item -Force ${psq(options.marker)},${psq(options.ready)} -ErrorAction SilentlyContinue`,
    `  Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)} -ErrorAction SilentlyContinue`,
    "  throw",
    "}",
    `Remove-Item -Recurse -Force ${psq(options.backup)} -ErrorAction SilentlyContinue`,
    `Remove-Item -Recurse -Force ${psq(options.workDir)} -ErrorAction SilentlyContinue`,
    `Remove-Item -Force ${psq(options.marker)},${psq(options.ready)} -ErrorAction SilentlyContinue`,
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
    "  cleanup_handoff",
    "  exit 1",
    "fi",
    "if ! command -v setsid >/dev/null 2>&1; then",
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -x "$EXE"',
    "  cleanup_handoff",
    "  exit 1",
    "fi",
    'setsid "$EXE" >/dev/null 2>&1 < /dev/null &',
    "NEW_PID=$!",
    "READY_OK=0",
    "i=0",
    'while [ "$i" -lt 300 ]; do',
    '  if ! kill -0 "$NEW_PID" 2>/dev/null; then break; fi',
    '  if [ -f "$READY" ]; then READY_OK=1; break; fi',
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    'if [ "$READY_OK" -ne 1 ]; then',
    '  kill "$NEW_PID" 2>/dev/null || true',
    '  wait "$NEW_PID" 2>/dev/null || true',
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -x "$EXE"',
    "  cleanup_handoff",
    '  setsid "$EXE" >/dev/null 2>&1 < /dev/null &',
    "  exit 1",
    "fi",
    'rm -rf "$OLD"',
    'rm -rf "$WORK"',
    "cleanup_handoff",
  ].join("\n");
}

export function renderMacApplyShell(options: ShellScriptOptions & { executable: string }): string {
  return [
    ...shellPrelude(options),
    `EXE=${sh(options.executable)}`,
    'mv "$APP" "$OLD"',
    'if ! mv "$NEW" "$APP"; then',
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    '  test -d "$APP"',
    "  cleanup_handoff",
    "  exit 1",
    "fi",
    'xattr -r -d com.apple.quarantine "$APP" 2>/dev/null || true',
    'nohup "$EXE" >/dev/null 2>&1 < /dev/null &',
    "NEW_PID=$!",
    "READY_OK=0",
    "i=0",
    'while [ "$i" -lt 300 ]; do',
    '  if ! kill -0 "$NEW_PID" 2>/dev/null; then break; fi',
    '  if [ -f "$READY" ]; then READY_OK=1; break; fi',
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    'if [ "$READY_OK" -ne 1 ]; then',
    '  kill "$NEW_PID" 2>/dev/null || true',
    '  wait "$NEW_PID" 2>/dev/null || true',
    '  rm -rf "$APP"',
    '  mv "$OLD" "$APP"',
    "  cleanup_handoff",
    '  open "$APP" || true',
    "  exit 1",
    "fi",
    'rm -rf "$OLD"',
    'rm -rf "$WORK"',
    "cleanup_handoff",
  ].join("\n");
}

/** Start a detached platform helper that swaps the app after this process exits. */
export async function applyUpdateAndRelaunch(options: ApplyOptions): Promise<void> {
  const handoff = prepareUpdateHandoff(options.version.identifier, options.targetVersion);
  try {
    if (IS_WINDOWS) return await applyWindows(options, handoff);
    if (IS_LINUX) {
      applyLinux(options, handoff);
      return;
    }
    applyMac(options, handoff);
  } catch (error) {
    abandonUpdateHandoff(handoff);
    throw error;
  }
}

async function applyWindows(
  { resourcesDir, staged, workDir, version }: ApplyOptions,
  handoff: PreparedUpdateHandoff,
): Promise<void> {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, `${version.name}.exe`);
  const token = handoff.token;
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
      marker: handoff.markerPath,
      ready: handoff.readyPath,
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
    const helperPid = parseHelperPid(readFileSync(helperPidFile, "utf8"));
    try {
      activateUpdateHandoff(handoff, helperPid);
    } catch (error) {
      try {
        process.kill(helperPid);
      } catch {
        // The helper may already have exited; reservation cleanup still follows.
      }
      throw error;
    }
  } catch (error) {
    for (const file of helperFiles) removePathBestEffort(file);
    throw error;
  }
}

function applyLinux(
  { resourcesDir, staged, workDir, version }: ApplyOptions,
  handoff: PreparedUpdateHandoff,
): void {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, version.name);
  const backup = `${runningApp}.mirin-old-${process.pid}-${crypto.randomUUID()}`;
  spawnShellSwap(
    renderLinuxApplyShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      marker: handoff.markerPath,
      ready: handoff.readyPath,
    }),
    workDir,
    handoff,
  );
}

function applyMac(
  { resourcesDir, staged, workDir, version }: ApplyOptions,
  handoff: PreparedUpdateHandoff,
): void {
  const runningApp = join(resourcesDir, "..", "..");
  const executable = join(runningApp, "Contents", "MacOS", version.name);
  const backup = `${runningApp}.mirin-old-${process.pid}-${crypto.randomUUID()}`;
  spawnShellSwap(
    renderMacApplyShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      marker: handoff.markerPath,
      ready: handoff.readyPath,
    }),
    workDir,
    handoff,
  );
}

function shellPrelude(options: ShellScriptOptions): string[] {
  return [
    "set -eu",
    `APP=${sh(options.runningApp)}`,
    `NEW=${sh(options.staged)}`,
    `WORK=${sh(options.workDir)}`,
    `HANDOFF=${sh(options.marker)}`,
    `READY=${sh(options.ready)}`,
    `PID=${options.pid ?? process.pid}`,
    `OLD=${sh(options.backup ?? `${options.runningApp}.mirin-old-${options.pid ?? process.pid}`)}`,
    'cleanup_handoff() { rm -f "$HANDOFF" "$READY"; }',
    'if [ -e "$OLD" ]; then exit 1; fi',
    "i=0",
    'while kill -0 "$PID" 2>/dev/null; do',
    '  if [ "$i" -ge 150 ]; then cleanup_handoff; exit 1; fi',
    "  i=$((i + 1))",
    "  sleep 0.2",
    "done",
    'rm -f "$READY"',
  ];
}

function spawnShellSwap(script: string, workDir: string, handoff: PreparedUpdateHandoff): void {
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
    activateUpdateHandoff(handoff, helper.pid);
  } catch (error) {
    helper.kill();
    throw error;
  }
  helper.unref();
}

function parseHelperPid(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("updater helper returned an invalid process id");
  }
  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) {
    throw new Error("updater helper returned an invalid process id");
  }
  return pid;
}

/**
 * AppImage mounts and system package roots cannot be atomically replaced by an
 * unprivileged helper. Probe the exact parent before transaction handoff.
 */
export function assertLinuxInstallCanApply(
  resourcesDir: string,
  appImage = process.env.APPIMAGE,
  createProbe: (prefix: string) => string = mkdtempSync,
  removeProbe: (path: string) => void = (path) => rmSync(path, { recursive: true }),
): void {
  if (appImage) {
    throw new Error(
      "automatic update apply is unavailable for AppImage installs; install the published package update",
    );
  }
  const parent = dirname(join(resourcesDir, ".."));
  let probe: string | undefined;
  try {
    probe = createProbe(join(parent, ".mirin-update-probe-"));
  } catch {
    throw new Error(
      "automatic update apply cannot write this Linux install; use the system package manager",
    );
  }
  try {
    removeProbe(probe);
  } catch {
    throw new Error("automatic update apply could not clean its Linux install probe");
  }
}
