import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  abandonUpdateHandoff,
  activateUpdateHandoff,
  type PreparedUpdateHandoff,
  prepareUpdateHandoff,
  UPDATE_HANDOFF_TOKEN_ENV,
} from "../../update-handoff.ts";
import type { VersionInfo } from "../types.ts";
import { APPLY_HELPER_ARMED_FILE, APPLY_HELPER_PID_FILE, removePathBestEffort } from "./cleanup.ts";
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
  armed: string;
  token: string;
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
    "Set-Location -LiteralPath $env:TEMP",
    "$parentExited=$false",
    "$newProcess=$null",
    "try {",
    `  if (Test-Path -LiteralPath ${psq(options.backup)}) { throw 'Updater backup path already exists' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.runningApp)} -PathType Container)) { throw 'Installed app path is unavailable' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.staged)} -PathType Container)) { throw 'Install-filesystem stage is unavailable' }`,
    `  [System.IO.File]::WriteAllText(${psq(options.armed)},[string]$PID,[System.Text.Encoding]::ASCII)`,
    "  $parentDeadline=(Get-Date).AddSeconds(30)",
    `  while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {`,
    "    if ((Get-Date) -ge $parentDeadline) { throw 'Application did not exit for updater handoff' }",
    "    Start-Sleep -Milliseconds 200",
    "  }",
    "  $parentExited=$true",
    `  Remove-Item -LiteralPath ${psq(options.ready)} -Force -ErrorAction SilentlyContinue`,
    `  for ($i=0; $i -lt 50; $i++) { try { Move-Item -LiteralPath ${psq(options.runningApp)} -Destination ${psq(options.backup)} -ErrorAction Stop } catch {}; if ((Test-Path -LiteralPath ${psq(options.backup)}) -and -not (Test-Path -LiteralPath ${psq(options.runningApp)})) { break }; Start-Sleep -Milliseconds 200 }`,
    `  if ((Test-Path -LiteralPath ${psq(options.runningApp)}) -or -not (Test-Path -LiteralPath ${psq(options.backup)})) { throw 'Could not unlock the existing app' }`,
    `  Move-Item -LiteralPath ${psq(options.staged)} -Destination ${psq(options.runningApp)} -ErrorAction Stop`,
    `  $env:${UPDATE_HANDOFF_TOKEN_ENV}=${psq(options.token)}`,
    "  try {",
    `    $newProcess=Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)} -PassThru`,
    "  } finally {",
    `    Remove-Item -LiteralPath Env:${UPDATE_HANDOFF_TOKEN_ENV} -ErrorAction SilentlyContinue`,
    "  }",
    "  $readyDeadline=(Get-Date).AddSeconds(30)",
    "  $readyOk=$false",
    "  while (-not $readyOk) {",
    "    $newProcess.Refresh()",
    "    if ($newProcess.HasExited) { throw 'Replacement exited before reporting ready' }",
    "    if ((Get-Date) -ge $readyDeadline) { throw 'Replacement did not report ready' }",
    `    if (Test-Path -LiteralPath ${psq(options.ready)} -PathType Leaf) {`,
    `      $readyPid=(Get-Content -LiteralPath ${psq(options.ready)} -Raw).Trim()`,
    "      if ($readyPid -ne [string]$newProcess.Id) { throw 'Replacement readiness receipt has the wrong process id' }",
    "      $readyOk=$true",
    "      continue",
    "    }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  $newProcess.Refresh()",
    "  if ($newProcess.HasExited) { throw 'Replacement exited after reporting ready' }",
    `  Remove-Item -LiteralPath ${psq(options.backup)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath ${psq(options.workDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.ready)},${psq(options.armed)} -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath ${helperFiles} -Force -ErrorAction SilentlyContinue`,
    "} catch {",
    "  $failure=$_",
    "  $rollbackFailure=$null",
    "  try {",
    "    $canRestore=$true",
    "    if ($null -ne $newProcess -and -not $newProcess.HasExited) {",
    "      Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue",
    "      $canRestore=$newProcess.WaitForExit(5000)",
    "    }",
    "    if ($parentExited -and $canRestore) {",
    `      if (Test-Path -LiteralPath ${psq(options.backup)}) {`,
    `        Remove-Item -LiteralPath ${psq(options.runningApp)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `        Move-Item -LiteralPath ${psq(options.backup)} -Destination ${psq(options.runningApp)} -ErrorAction Stop`,
    "      }",
    `      if ((Test-Path -LiteralPath ${psq(options.backup)}) -or -not (Test-Path -LiteralPath ${psq(options.executable)} -PathType Leaf)) { throw 'Update rollback failed' }`,
    `      Remove-Item -LiteralPath ${psq(options.staged)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.ready)},${psq(options.armed)} -Force -ErrorAction SilentlyContinue`,
    `      Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)} -ErrorAction Stop`,
    "    }",
    "    if (-not $parentExited) {",
    `      Remove-Item -LiteralPath ${psq(options.staged)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Remove-Item -LiteralPath ${psq(options.workDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    "    }",
    "  } catch {",
    "    $rollbackFailure=$_",
    "  }",
    `  Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.ready)},${psq(options.armed)} -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath ${helperFiles} -Force -ErrorAction SilentlyContinue`,
    "  if ($null -ne $rollbackFailure) { throw $rollbackFailure }",
    "  throw $failure",
    "}",
  ].join("\n");
}

export function renderLinuxApplyShell(
  options: ShellScriptOptions & { executable: string },
): string {
  return renderPosixApplyShell(options, "linux");
}

export function renderMacApplyShell(options: ShellScriptOptions & { executable: string }): string {
  return renderPosixApplyShell(options, "darwin");
}

function renderPosixApplyShell(
  options: ShellScriptOptions & { executable: string },
  platform: "darwin" | "linux",
): string {
  return [
    "set -eu",
    "umask 077",
    `APP=${sh(options.runningApp)}`,
    `NEW=${sh(options.staged)}`,
    `WORK=${sh(options.workDir)}`,
    `HANDOFF=${sh(options.marker)}`,
    `READY=${sh(options.ready)}`,
    `ARMED=${sh(options.armed)}`,
    `TOKEN=${sh(options.token)}`,
    `PID=${options.pid ?? process.pid}`,
    `OLD=${sh(options.backup ?? `${options.runningApp}.mirin-old-${options.pid ?? process.pid}`)}`,
    `EXE=${sh(options.executable)}`,
    "PARENT_EXITED=0",
    "NEW_PID=",
    'cleanup_handoff() { rm -f "$HANDOFF" "$READY" "$ARMED"; }',
    "stop_replacement() {",
    '  if [ -z "$NEW_PID" ] || ! kill -0 "$NEW_PID" 2>/dev/null; then',
    '    if [ -n "$NEW_PID" ]; then wait "$NEW_PID" 2>/dev/null || true; fi',
    "    return 0",
    "  fi",
    '  kill "$NEW_PID" 2>/dev/null || true',
    "  i=0",
    '  while [ "$i" -lt 50 ] && kill -0 "$NEW_PID" 2>/dev/null; do',
    "    i=$((i + 1))",
    "    sleep 0.1",
    "  done",
    '  if kill -0 "$NEW_PID" 2>/dev/null; then kill -KILL "$NEW_PID" 2>/dev/null || true; fi',
    "  i=0",
    '  while [ "$i" -lt 50 ] && kill -0 "$NEW_PID" 2>/dev/null; do',
    "    i=$((i + 1))",
    "    sleep 0.1",
    "  done",
    '  if kill -0 "$NEW_PID" 2>/dev/null; then return 1; fi',
    '  wait "$NEW_PID" 2>/dev/null || true',
    "  return 0",
    "}",
    ...(platform === "linux"
      ? [
          `launch_new() { ${UPDATE_HANDOFF_TOKEN_ENV}="$TOKEN" setsid "$EXE" >/dev/null 2>&1 < /dev/null & NEW_PID=$!; }`,
          'relaunch_old() { setsid "$EXE" >/dev/null 2>&1 < /dev/null & }',
        ]
      : [
          `launch_new() { ${UPDATE_HANDOFF_TOKEN_ENV}="$TOKEN" nohup "$EXE" >/dev/null 2>&1 < /dev/null & NEW_PID=$!; }`,
          'relaunch_old() { open "$APP" >/dev/null 2>&1 || true; }',
        ]),
    "rollback() {",
    "  status=$?",
    "  trap - EXIT HUP INT TERM",
    '  if [ "$PARENT_EXITED" -eq 1 ]; then',
    "    if stop_replacement; then",
    "      restored=1",
    '      if [ -e "$OLD" ]; then',
    '        rm -rf "$APP" || restored=0',
    '        if [ "$restored" -eq 1 ]; then mv "$OLD" "$APP" || restored=0; fi',
    "      fi",
    '      rm -rf "$NEW" 2>/dev/null || true',
    "      cleanup_handoff",
    '      if [ "$restored" -eq 1 ] && [ -x "$EXE" ]; then relaunch_old; fi',
    '      if [ "$restored" -eq 1 ]; then rm -rf "$WORK" 2>/dev/null || true; fi',
    "    else",
    "      cleanup_handoff",
    "    fi",
    "  else",
    '    rm -rf "$NEW" "$WORK" 2>/dev/null || true',
    "    cleanup_handoff",
    "  fi",
    '  exit "$status"',
    "}",
    "trap rollback EXIT HUP INT TERM",
    "cd /",
    'test ! -e "$OLD"',
    'test -d "$APP"',
    'test -d "$NEW"',
    ...(platform === "linux" ? ["command -v setsid >/dev/null 2>&1"] : []),
    'printf "%s" "$$" > "$ARMED"',
    "i=0",
    'while kill -0 "$PID" 2>/dev/null; do',
    '  if [ "$i" -ge 150 ]; then exit 1; fi',
    "  i=$((i + 1))",
    "  sleep 0.2",
    "done",
    "PARENT_EXITED=1",
    'rm -f "$READY"',
    'mv "$APP" "$OLD"',
    'mv "$NEW" "$APP"',
    ...(platform === "darwin"
      ? ['xattr -r -d com.apple.quarantine "$APP" 2>/dev/null || true']
      : []),
    "launch_new",
    "READY_OK=0",
    "i=0",
    'while [ "$i" -lt 300 ]; do',
    '  if ! kill -0 "$NEW_PID" 2>/dev/null; then break; fi',
    '  READY_PID=""',
    '  if [ -f "$READY" ]; then IFS= read -r READY_PID < "$READY" || true; fi',
    '  if [ "$READY_PID" = "$NEW_PID" ]; then READY_OK=1; break; fi',
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    'test "$READY_OK" -eq 1',
    'kill -0 "$NEW_PID" 2>/dev/null',
    "trap - EXIT HUP INT TERM",
    'rm -rf "$OLD" 2>/dev/null || true',
    'rm -rf "$WORK" 2>/dev/null || true',
    "cleanup_handoff || true",
    "exit 0",
  ].join("\n");
}

/** Start a detached platform helper that swaps the app after this process exits. */
export async function applyUpdateAndRelaunch(options: ApplyOptions): Promise<void> {
  const handoff = prepareUpdateHandoff(options.version.identifier, options.targetVersion);
  try {
    if (IS_WINDOWS) return await applyWindows(options, handoff);
    if (IS_LINUX) {
      await applyLinux(options, handoff);
      return;
    }
    await applyMac(options, handoff);
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
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
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
      armed,
      token,
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
      await waitForHelperArmed(armed, helperPid);
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

async function applyLinux(
  { resourcesDir, staged, workDir, version }: ApplyOptions,
  handoff: PreparedUpdateHandoff,
): Promise<void> {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, version.name);
  const backup = `${runningApp}.mirin-old-${handoff.token}`;
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  await spawnShellSwap(
    renderLinuxApplyShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      marker: handoff.markerPath,
      ready: handoff.readyPath,
      armed,
      token: handoff.token,
    }),
    workDir,
    handoff,
  );
}

async function applyMac(
  { resourcesDir, staged, workDir, version }: ApplyOptions,
  handoff: PreparedUpdateHandoff,
): Promise<void> {
  const runningApp = join(resourcesDir, "..", "..");
  const executable = join(runningApp, "Contents", "MacOS", version.name);
  const backup = `${runningApp}.mirin-old-${handoff.token}`;
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  await spawnShellSwap(
    renderMacApplyShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      marker: handoff.markerPath,
      ready: handoff.readyPath,
      armed,
      token: handoff.token,
    }),
    workDir,
    handoff,
  );
}

async function spawnShellSwap(
  script: string,
  workDir: string,
  handoff: PreparedUpdateHandoff,
): Promise<void> {
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
    await waitForHelperArmed(join(workDir, APPLY_HELPER_ARMED_FILE), helper.pid);
  } catch (error) {
    helper.kill();
    throw error;
  }
  helper.unref();
}

async function waitForHelperArmed(
  armedPath: string,
  helperPid: number,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const metadata = lstatSync(armedPath);
      if (metadata.isFile() && metadata.size > 0 && metadata.size <= 32) {
        if (parseHelperPid(readFileSync(armedPath, "utf8")) === helperPid) {
          if (!isAlive(helperPid)) {
            throw new Error("updater helper exited after accepting terminal handoff");
          }
          return;
        }
        throw new Error("updater helper armed acknowledgement has the wrong process id");
      }
    } catch (error) {
      if (error instanceof Error && !("code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (!isAlive(helperPid)) {
      throw new Error("updater helper exited before accepting terminal handoff");
    }
    await Bun.sleep(25);
  }
  throw new Error("updater helper did not accept terminal handoff");
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
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
