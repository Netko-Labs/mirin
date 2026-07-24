import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  APPLY_HELPER_ACTIVATED_FILE,
  APPLY_HELPER_ARMED_FILE,
  APPLY_HELPER_PID_FILE,
  removePathBestEffort,
} from "./cleanup.ts";
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
  activated: string;
  armed: string;
  swapTool: string;
  token: string;
  pid?: number;
  backup?: string;
}

interface WindowsScriptOptions extends ShellScriptOptions {
  executable: string;
  backup: string;
  helperFiles: string[];
}

class PreservedHelperOwnershipError extends Error {
  constructor(cause: unknown) {
    super("updater helper ownership could not be released safely", { cause });
    this.name = "PreservedHelperOwnershipError";
  }
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
    "$accepted=$false",
    "$parentExited=$false",
    "$swapped=$false",
    "$preserveOwnership=$false",
    "$newProcess=$null",
    "try {",
    `  if (Test-Path -LiteralPath ${psq(options.backup)}) { throw 'Updater backup path already exists' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.runningApp)} -PathType Container)) { throw 'Installed app path is unavailable' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.staged)} -PathType Container)) { throw 'Install-filesystem stage is unavailable' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.swapTool)} -PathType Leaf)) { throw 'Atomic updater swap tool is unavailable' }`,
    "  $activationDeadline=(Get-Date).AddSeconds(5)",
    "  while ($true) {",
    `    if (Test-Path -LiteralPath ${psq(options.activated)} -PathType Leaf) {`,
    `      $activatedPid=(Get-Content -LiteralPath ${psq(options.activated)} -Raw).Trim()`,
    "      if ($activatedPid -ne [string]$PID) { throw 'Updater helper activation has the wrong process id' }",
    "      break",
    "    }",
    `    if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { throw 'Application exited before updater helper activation' }`,
    "    if ((Get-Date) -ge $activationDeadline) { throw 'Updater helper was not activated' }",
    "    Start-Sleep -Milliseconds 25",
    "  }",
    `  $armedTemp=${psq(`${options.armed}.tmp`)}+'.'+[string]$PID`,
    "  [System.IO.File]::WriteAllText($armedTemp,[string]$PID,[System.Text.Encoding]::ASCII)",
    `  Move-Item -LiteralPath $armedTemp -Destination ${psq(options.armed)} -ErrorAction Stop`,
    "  $accepted=$true",
    "  $parentDeadline=(Get-Date).AddSeconds(30)",
    `  while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {`,
    "    if ((Get-Date) -ge $parentDeadline) {",
    `      Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    "      $forcedDeadline=(Get-Date).AddSeconds(5)",
    `      while ((Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -and (Get-Date) -lt $forcedDeadline) { Start-Sleep -Milliseconds 100 }`,
    `      if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { throw 'Application could not be terminated for updater handoff' }`,
    "      break",
    "    }",
    "    Start-Sleep -Milliseconds 200",
    "  }",
    "  $parentExited=$true",
    `  Remove-Item -LiteralPath ${psq(options.ready)} -Force -ErrorAction SilentlyContinue`,
    `  & ${psq(options.swapTool)} atomic-swap ${psq(options.runningApp)} ${psq(options.staged)}`,
    "  if ($LASTEXITCODE -ne 0) { throw 'Could not atomically exchange the installed app' }",
    "  $swapped=$true",
    `  Move-Item -LiteralPath ${psq(options.staged)} -Destination ${psq(options.backup)} -ErrorAction Stop`,
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
    `  Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.ready)},${psq(options.activated)},${psq(options.armed)} -Force -ErrorAction SilentlyContinue`,
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
    "      $restorePath=$null",
    `      if (Test-Path -LiteralPath ${psq(options.backup)} -PathType Container) { $restorePath=${psq(options.backup)} }`,
    `      elseif ($swapped -and (Test-Path -LiteralPath ${psq(options.staged)} -PathType Container)) { $restorePath=${psq(options.staged)} }`,
    "      if ($null -ne $restorePath) {",
    `        & ${psq(options.swapTool)} atomic-swap ${psq(options.runningApp)} $restorePath`,
    "        if ($LASTEXITCODE -ne 0) { throw 'Update rollback exchange failed' }",
    "        Remove-Item -LiteralPath $restorePath -Recurse -Force -ErrorAction SilentlyContinue",
    "      }",
    `      if ((Test-Path -LiteralPath ${psq(options.backup)}) -or -not (Test-Path -LiteralPath ${psq(options.executable)} -PathType Leaf)) { throw 'Update rollback failed' }`,
    `      Remove-Item -LiteralPath ${psq(options.staged)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.ready)},${psq(options.activated)},${psq(options.armed)} -Force -ErrorAction SilentlyContinue`,
    `      Remove-Item -LiteralPath ${psq(options.workDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Start-Process -FilePath ${psq(options.executable)} -WorkingDirectory ${psq(options.runningApp)} -ErrorAction Stop`,
    "    }",
    "    elseif ($parentExited -or $accepted) {",
    "      $preserveOwnership=$true",
    "    }",
    "    else {",
    `      Remove-Item -LiteralPath ${psq(options.staged)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Remove-Item -LiteralPath ${psq(options.workDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    "    }",
    "  } catch {",
    "    $rollbackFailure=$_",
    "    $preserveOwnership=$true",
    "  }",
    "  if (-not $preserveOwnership) {",
    `    Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.ready)},${psq(options.activated)},${psq(options.armed)},$armedTemp -Force -ErrorAction SilentlyContinue`,
    `    Remove-Item -LiteralPath ${helperFiles} -Force -ErrorAction SilentlyContinue`,
    "  }",
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
    `ACTIVATED=${sh(options.activated)}`,
    `ARMED=${sh(options.armed)}`,
    `SWAP=${sh(options.swapTool)}`,
    `TOKEN=${sh(options.token)}`,
    `PID=${options.pid ?? process.pid}`,
    `OLD=${sh(options.backup ?? `${options.runningApp}.mirin-old-${options.pid ?? process.pid}`)}`,
    `EXE=${sh(options.executable)}`,
    "PARENT_EXITED=0",
    "ACCEPTED=0",
    "SWAPPED=0",
    "PRESERVE_OWNERSHIP=0",
    "NEW_PID=",
    'ARMED_TMP="$ARMED.tmp.$$"',
    'cleanup_handoff() { rm -f "$HANDOFF" "$READY" "$ACTIVATED" "$ARMED" "$ARMED_TMP"; }',
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
    "      RESTORE=",
    '      if [ -d "$OLD" ]; then RESTORE="$OLD";',
    '      elif [ "$SWAPPED" -eq 1 ] && [ -d "$NEW" ]; then RESTORE="$NEW"; fi',
    '      if [ -n "$RESTORE" ]; then',
    '        "$SWAP" atomic-swap "$APP" "$RESTORE" || restored=0',
    '        if [ "$restored" -eq 1 ]; then rm -rf "$RESTORE" 2>/dev/null || true; fi',
    "      fi",
    '      if [ "$restored" -eq 1 ] && [ -x "$EXE" ]; then',
    '        rm -rf "$NEW" 2>/dev/null || true',
    "        cleanup_handoff",
    "        relaunch_old",
    '        rm -rf "$WORK" 2>/dev/null || true',
    "      else",
    "        PRESERVE_OWNERSHIP=1",
    "      fi",
    "    else",
    "      PRESERVE_OWNERSHIP=1",
    "    fi",
    '  elif [ "$ACCEPTED" -eq 1 ]; then',
    "    PRESERVE_OWNERSHIP=1",
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
    'test -x "$SWAP"',
    ...(platform === "linux" ? ["command -v setsid >/dev/null 2>&1"] : []),
    "i=0",
    "while :; do",
    '  if [ -f "$ACTIVATED" ]; then',
    '    ACTIVATED_PID=""',
    '    IFS= read -r ACTIVATED_PID < "$ACTIVATED" || true',
    '    test "$ACTIVATED_PID" = "$$"',
    "    break",
    "  fi",
    '  kill -0 "$PID" 2>/dev/null || exit 1',
    '  if [ "$i" -ge 100 ]; then exit 1; fi',
    "  i=$((i + 1))",
    "  sleep 0.05",
    "done",
    'printf "%s" "$$" > "$ARMED_TMP"',
    'mv "$ARMED_TMP" "$ARMED"',
    "ACCEPTED=1",
    "i=0",
    'while [ "$i" -lt 150 ] && kill -0 "$PID" 2>/dev/null; do',
    "  i=$((i + 1))",
    "  sleep 0.2",
    "done",
    'if kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null || true; fi',
    "i=0",
    'while [ "$i" -lt 50 ] && kill -0 "$PID" 2>/dev/null; do',
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    'if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID" 2>/dev/null || true; fi',
    "i=0",
    'while [ "$i" -lt 50 ] && kill -0 "$PID" 2>/dev/null; do',
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    'kill -0 "$PID" 2>/dev/null && exit 1',
    "PARENT_EXITED=1",
    'rm -f "$READY"',
    '"$SWAP" atomic-swap "$APP" "$NEW"',
    "SWAPPED=1",
    'mv "$NEW" "$OLD"',
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
    // An activated helper whose death cannot be confirmed still owns the
    // terminal handoff. Its reservation and recovery trees must remain intact,
    // and the caller must continue with terminal shutdown.
    if (error instanceof PreservedHelperOwnershipError) return;
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
  const activated = join(workDir, APPLY_HELPER_ACTIVATED_FILE);
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  const swapTool = await prepareAtomicSwapTool(
    join(runningApp, "mirin-codec.exe"),
    runningApp,
    workDir,
  );
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
      activated,
      armed,
      swapTool,
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
    let activationPublished = false;
    try {
      authorizeHelperSwap(handoff, helperPid, activated);
      activationPublished = true;
      await waitForHelperArmed(armed, helperPid);
    } catch (error) {
      if (!(await terminateProcess(helperPid)) && activationPublished) {
        throw new PreservedHelperOwnershipError(error);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof PreservedHelperOwnershipError) throw error;
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
  const activated = join(workDir, APPLY_HELPER_ACTIVATED_FILE);
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  const swapTool = await prepareAtomicSwapTool(
    join(runningApp, "mirin-codec"),
    runningApp,
    workDir,
  );
  await spawnShellSwap(
    renderLinuxApplyShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      marker: handoff.markerPath,
      ready: handoff.readyPath,
      activated,
      armed,
      swapTool,
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
  const activated = join(workDir, APPLY_HELPER_ACTIVATED_FILE);
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  const swapTool = await prepareAtomicSwapTool(
    join(runningApp, "Contents", "MacOS", "mirin-codec"),
    runningApp,
    workDir,
  );
  await spawnShellSwap(
    renderMacApplyShell({
      runningApp,
      staged,
      workDir,
      executable,
      backup,
      marker: handoff.markerPath,
      ready: handoff.readyPath,
      activated,
      armed,
      swapTool,
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
  let activationPublished = false;
  try {
    writeFileSync(join(workDir, APPLY_HELPER_PID_FILE), String(helper.pid), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    authorizeHelperSwap(handoff, helper.pid, join(workDir, APPLY_HELPER_ACTIVATED_FILE));
    activationPublished = true;
    await waitForHelperArmed(join(workDir, APPLY_HELPER_ARMED_FILE), helper.pid);
  } catch (error) {
    if (!(await terminateSpawnedHelper(helper)) && activationPublished) {
      helper.unref();
      throw new PreservedHelperOwnershipError(error);
    }
    throw error;
  }
  helper.unref();
}

/** Publish activation only after the durable reservation identifies this helper. */
function authorizeHelperSwap(
  handoff: PreparedUpdateHandoff,
  helperPid: number,
  activatedPath: string,
): void {
  activateUpdateHandoff(handoff, helperPid);
  signalHelperActivation(activatedPath, helperPid);
}

function signalHelperActivation(path: string, helperPid: number): void {
  const temporary = `${path}.${helperPid}.tmp`;
  try {
    writeFileSync(temporary, String(helperPid), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    removePathBestEffort(temporary);
  }
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

async function prepareAtomicSwapTool(
  bundledTool: string,
  runningApp: string,
  workDir: string,
): Promise<string> {
  const metadata = lstatSync(bundledTool);
  if (!metadata.isFile()) throw new Error("installed atomic updater swap tool is invalid");
  const tool = join(workDir, IS_WINDOWS ? ".mirin-atomic-swap.exe" : ".mirin-atomic-swap");
  copyFileSync(bundledTool, tool, fsConstants.COPYFILE_EXCL);
  if (!IS_WINDOWS) chmodSync(tool, 0o700);

  const probe = mkdtempSync(join(dirname(runningApp), ".mirin-atomic-swap-probe-"));
  try {
    const left = join(probe, "left");
    const right = join(probe, "right");
    mkdirSync(left);
    mkdirSync(right);
    writeFileSync(join(left, "left"), "left", { flag: "wx", mode: 0o600 });
    writeFileSync(join(right, "right"), "right", { flag: "wx", mode: 0o600 });
    const process = Bun.spawn([tool, "atomic-swap", left, right], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await process.exited) !== 0) {
      throw new Error("install filesystem does not support atomic updater swaps");
    }
    if (!existsSync(join(left, "right")) || !existsSync(join(right, "left"))) {
      throw new Error("atomic updater swap probe returned an invalid result");
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return tool;
}

async function terminateSpawnedHelper(helper: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  try {
    helper.kill();
  } catch {
    // It may already have exited.
  }
  if (await subprocessExitedWithin(helper, 2000)) return true;
  try {
    helper.kill(9);
  } catch {
    // A concurrent exit is confirmed below.
  }
  return subprocessExitedWithin(helper, 5000);
}

async function subprocessExitedWithin(
  helper: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([helper.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!processIsAlive(pid)) return true;
  try {
    process.kill(pid);
  } catch {
    // A concurrent exit is confirmed by polling.
  }
  if (await processExitedWithin(pid, 2000)) return true;
  try {
    process.kill(pid, 9);
  } catch {
    // A concurrent exit is confirmed by polling.
  }
  return processExitedWithin(pid, 5000);
}

async function processExitedWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !processIsAlive(pid);
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
