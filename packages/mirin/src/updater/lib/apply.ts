import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import {
  formatProcessIdentity,
  parseProcessIdentity,
  processIdentity,
  processIdentityMatches,
  type UpdateProcessIdentity,
} from "../../update-process.ts";
import type { VersionInfo } from "../types.ts";
import {
  APPLY_HELPER_ACTIVATED_FILE,
  APPLY_HELPER_ARMED_FILE,
  APPLY_HELPER_LAUNCH_PID_FILE,
  APPLY_HELPER_PID_FILE,
  removePathBestEffort,
} from "./cleanup.ts";
import { IS_LINUX, IS_WINDOWS, psq, sh } from "./platform.ts";

const ATOMIC_SWAP_DURABILITY_EXIT_CODE = 2;

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
  phase: string;
  replacement?: string;
  swapTool: string;
  token: string;
  parentToken?: string;
  pid?: number;
  backup?: string;
}

interface WindowsScriptOptions extends ShellScriptOptions {
  executable: string;
  backup: string;
  helperFiles: string[];
  launchArguments?: string[];
  parentWaitMs?: number;
  readyWaitMs?: number;
  failurePoint?: "after-exchange" | "replacement-token";
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
      "  WScript.Quit 1",
      "End If",
      "pidFile.Write CStr(pid)",
      "pidFile.Close",
      "If Err.Number <> 0 Then",
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
  const parentToken = options.parentToken ?? "test-parent-token";
  const parentWaitMs = options.parentWaitMs ?? 30_000;
  const readyWaitMs = options.readyWaitMs ?? 30_000;
  const launchArguments = options.launchArguments?.length
    ? ` -ArgumentList ${options.launchArguments.map(psq).join(",")}`
    : "";
  const helperIdentity = join(options.workDir, APPLY_HELPER_PID_FILE);
  const replacementIdentity =
    options.replacement ?? join(dirname(options.marker), `.update-replacement-${options.token}`);
  const codec = (args: string[], failure: string, indent = "  "): string[] => [
    `${indent}& ${psq(options.swapTool)} ${args.map(psq).join(" ")}`,
    `${indent}if ($LASTEXITCODE -ne 0) { throw ${psq(failure)} }`,
  ];
  const durableDynamicWrite = (path: string, value: string, failure: string): string[] => [
    `  & ${psq(options.swapTool)} ${psq("durable-write")} ${psq(path)} ${value}`,
    `  if ($LASTEXITCODE -ne 0) { throw ${psq(failure)} }`,
  ];
  return [
    "$ErrorActionPreference='Stop'",
    "Set-Location -LiteralPath $env:TEMP",
    "$accepted=$false",
    "$parentExited=$false",
    "$swapped=$false",
    "$committed=$false",
    "$preserveOwnership=$false",
    "$newProcess=$null",
    "$newToken=$null",
    `$selfToken=(& ${psq(options.swapTool)} process-token ([string]$PID)).Trim()`,
    "if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($selfToken)) { throw 'Could not identify updater helper process' }",
    `$bootToken=(& ${psq(options.swapTool)} boot-token).Trim()`,
    "if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($bootToken)) { throw 'Could not identify the current boot session' }",
    "$selfIdentity=[string]$PID+'|'+$selfToken",
    `& ${psq(options.swapTool)} ${psq("durable-write")} ${psq(helperIdentity)} $selfIdentity`,
    "if ($LASTEXITCODE -ne 0) { throw 'Could not publish updater helper identity' }",
    "try {",
    `  if (Test-Path -LiteralPath ${psq(options.backup)}) { throw 'Updater backup path already exists' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.runningApp)} -PathType Container)) { throw 'Installed app path is unavailable' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.staged)} -PathType Container)) { throw 'Install-filesystem stage is unavailable' }`,
    `  if (-not (Test-Path -LiteralPath ${psq(options.swapTool)} -PathType Leaf)) { throw 'Atomic updater swap tool is unavailable' }`,
    "  $activationDeadline=(Get-Date).AddSeconds(5)",
    "  while ($true) {",
    `    if (Test-Path -LiteralPath ${psq(options.activated)} -PathType Leaf) {`,
    `      $activatedIdentity=(Get-Content -LiteralPath ${psq(options.activated)} -Raw).Trim()`,
    "      if ($activatedIdentity -ne $selfIdentity) { throw 'Updater helper activation has the wrong process identity' }",
    "      break",
    "    }",
    `    $observedParentToken=(& ${psq(options.swapTool)} process-token ${psq(String(pid))} 2>$null).Trim()`,
    `    if ($LASTEXITCODE -ne 0 -or $observedParentToken -ne ${psq(parentToken)}) { throw 'Application exited before updater helper activation' }`,
    "    if ((Get-Date) -ge $activationDeadline) { throw 'Updater helper was not activated' }",
    "    Start-Sleep -Milliseconds 25",
    "  }",
    ...codec(
      ["durable-write", options.phase, "activated"],
      "Could not journal updater helper activation",
    ),
    ...durableDynamicWrite(
      options.armed,
      "$selfIdentity",
      "Could not publish updater helper acceptance",
    ),
    "  $accepted=$true",
    `  & ${psq(options.swapTool)} wait-process ${psq(String(pid))} ${psq(parentToken)} ${psq(String(parentWaitMs))}`,
    "  if ($LASTEXITCODE -ne 0) {",
    `    & ${psq(options.swapTool)} terminate-process ${psq(String(pid))} ${psq(parentToken)}`,
    "    if ($LASTEXITCODE -ne 0) { throw 'Application could not be terminated for updater handoff' }",
    "  }",
    "  $parentExited=$true",
    `  Remove-Item -LiteralPath ${psq(options.ready)} -Force -ErrorAction SilentlyContinue`,
    ...codec(["durable-write", options.phase, "swap-pending"], "Could not journal updater swap"),
    `  & ${psq(options.swapTool)} atomic-swap ${psq(options.runningApp)} ${psq(options.staged)}`,
    "  $swapExit=$LASTEXITCODE",
    `  if ($swapExit -eq ${ATOMIC_SWAP_DURABILITY_EXIT_CODE}) {`,
    "    $swapped=$true",
    `    & ${psq(options.swapTool)} sync-parent ${psq(options.runningApp)}`,
    "    if ($LASTEXITCODE -ne 0) { throw 'Could not make updater swap durable' }",
    "  }",
    "  elseif ($swapExit -ne 0) { throw 'Could not atomically exchange the installed app' }",
    "  else { $swapped=$true }",
    ...(options.failurePoint === "after-exchange"
      ? ["  throw 'Injected updater failure after exchange'"]
      : []),
    ...codec(
      ["durable-write", options.phase, "backup-pending"],
      "Could not journal updater backup transition",
    ),
    ...codec(
      ["durable-move", options.staged, options.backup],
      "Could not durably retain the previous app",
    ),
    ...codec(
      ["durable-write", options.phase, "backed-up"],
      "Could not journal updater backup completion",
    ),
    ...codec(["durable-write", options.phase, "launching"], "Could not journal replacement launch"),
    "$replacementGuard='pending:'+$bootToken+':launch'",
    ...durableDynamicWrite(
      replacementIdentity,
      "$replacementGuard",
      "Could not guard replacement launch",
    ),
    `  $env:${UPDATE_HANDOFF_TOKEN_ENV}=${psq(options.token)}`,
    "  try {",
    `    $newProcess=Start-Process -FilePath ${psq(options.executable)}${launchArguments} -WorkingDirectory ${psq(options.runningApp)} -PassThru`,
    "  } finally {",
    `    Remove-Item -LiteralPath Env:${UPDATE_HANDOFF_TOKEN_ENV} -ErrorAction SilentlyContinue`,
    "  }",
    "  $replacementGuard='pending:'+$bootToken+':'+[string]$newProcess.Id",
    ...durableDynamicWrite(
      replacementIdentity,
      "$replacementGuard",
      "Could not guard unidentified replacement process",
    ),
    ...(options.failurePoint === "replacement-token"
      ? ["  throw 'Injected replacement identity lookup failure'"]
      : [
          `  $newToken=(& ${psq(options.swapTool)} process-token ([string]$newProcess.Id)).Trim()`,
          "  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($newToken)) { throw 'Could not identify replacement process' }",
        ]),
    "  $readyIdentity=[string]$newProcess.Id+'|'+$newToken",
    ...durableDynamicWrite(
      replacementIdentity,
      "$readyIdentity",
      "Could not publish replacement process identity",
    ),
    `  $readyDeadline=(Get-Date).AddMilliseconds(${readyWaitMs})`,
    "  $readyOk=$false",
    "  while (-not $readyOk) {",
    "    $newProcess.Refresh()",
    "    if ($newProcess.HasExited) { throw 'Replacement exited before reporting ready' }",
    "    if ((Get-Date) -ge $readyDeadline) { throw 'Replacement did not report ready' }",
    `    if (Test-Path -LiteralPath ${psq(options.ready)} -PathType Leaf) {`,
    `      $readyProcess=(Get-Content -LiteralPath ${psq(options.ready)} -Raw).Trim()`,
    "      if ($readyProcess -ne $readyIdentity) { throw 'Replacement readiness receipt has the wrong process identity' }",
    "      $readyOk=$true",
    "      continue",
    "    }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  $newProcess.Refresh()",
    "  if ($newProcess.HasExited) { throw 'Replacement exited after reporting ready' }",
    ...codec(["durable-write", options.phase, "committed"], "Could not commit updater readiness"),
    "  $committed=$true",
    ...codec(
      ["durable-remove-directory", options.backup],
      "Could not durably remove the previous app",
    ),
    ...codec(
      ["durable-remove-file", options.marker],
      "Could not durably clear committed updater ownership",
    ),
    `  if (Test-Path -LiteralPath ${psq(replacementIdentity)} -PathType Leaf) {`,
    ...codec(
      ["durable-remove-file", replacementIdentity],
      "Could not clear replacement process identity",
      "    ",
    ),
    "  }",
    `  if (Test-Path -LiteralPath ${psq(options.ready)} -PathType Leaf) {`,
    ...codec(["durable-remove-file", options.ready], "Could not clear updater readiness", "    "),
    "  }",
    ...codec(
      ["durable-remove-file", options.phase],
      "Could not durably clear committed updater phase",
    ),
    `  Remove-Item -LiteralPath ${psq(options.workDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath ${helperFiles} -Force -ErrorAction SilentlyContinue`,
    "} catch {",
    "  $failure=$_",
    "  if ($committed) { throw $failure }",
    "  $rollbackFailure=$null",
    "  try {",
    "    $canRestore=$true",
    "    if ($null -ne $newProcess) {",
    "      $newProcess.Refresh()",
    "      if (-not $newProcess.HasExited) {",
    "        if ([string]::IsNullOrWhiteSpace($newToken)) {",
    "          $newProcess.WaitForExit()",
    "          $newProcess.Refresh()",
    "          $canRestore=$newProcess.HasExited",
    "        }",
    "        else {",
    `          & ${psq(options.swapTool)} terminate-process ([string]$newProcess.Id) $newToken`,
    "          $terminationSucceeded=($LASTEXITCODE -eq 0)",
    "          $newProcess.Refresh()",
    "          $canRestore=($terminationSucceeded -and $newProcess.HasExited)",
    "        }",
    "      }",
    "    }",
    "    if ($parentExited -and $canRestore) {",
    "      $restorePath=$null",
    `      if (Test-Path -LiteralPath ${psq(options.backup)} -PathType Container) { $restorePath=${psq(options.backup)} }`,
    `      elseif ($swapped -and (Test-Path -LiteralPath ${psq(options.staged)} -PathType Container)) { $restorePath=${psq(options.staged)} }`,
    "      if ($null -ne $restorePath) {",
    `        & ${psq(options.swapTool)} atomic-swap ${psq(options.runningApp)} $restorePath`,
    "        $rollbackSwapExit=$LASTEXITCODE",
    `        if ($rollbackSwapExit -eq ${ATOMIC_SWAP_DURABILITY_EXIT_CODE}) {`,
    `          & ${psq(options.swapTool)} sync-parent ${psq(options.runningApp)}`,
    "          if ($LASTEXITCODE -ne 0) { throw 'Update rollback durability failed' }",
    "        }",
    "        elseif ($rollbackSwapExit -ne 0) { throw 'Update rollback exchange failed' }",
    `        & ${psq(options.swapTool)} durable-remove-directory $restorePath`,
    "        if ($LASTEXITCODE -ne 0) { throw 'Update rollback cleanup failed' }",
    "      }",
    `      if ((Test-Path -LiteralPath ${psq(options.backup)}) -or -not (Test-Path -LiteralPath ${psq(options.executable)} -PathType Leaf)) { throw 'Update rollback failed' }`,
    `      Remove-Item -LiteralPath ${psq(options.staged)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      & ${psq(options.swapTool)} ${psq("durable-remove-file")} ${psq(options.marker)}`,
    "      if ($LASTEXITCODE -ne 0) { throw 'Could not durably clear rolled-back updater ownership' }",
    `      if (Test-Path -LiteralPath ${psq(replacementIdentity)} -PathType Leaf) {`,
    `        & ${psq(options.swapTool)} ${psq("durable-remove-file")} ${psq(replacementIdentity)}`,
    "        if ($LASTEXITCODE -ne 0) { throw 'Could not clear rolled-back replacement identity' }",
    "      }",
    `      if (Test-Path -LiteralPath ${psq(options.ready)} -PathType Leaf) {`,
    `        & ${psq(options.swapTool)} ${psq("durable-remove-file")} ${psq(options.ready)}`,
    "        if ($LASTEXITCODE -ne 0) { throw 'Could not clear rolled-back readiness' }",
    "      }",
    `      & ${psq(options.swapTool)} ${psq("durable-remove-file")} ${psq(options.phase)}`,
    "      if ($LASTEXITCODE -ne 0) { throw 'Could not durably clear rolled-back updater phase' }",
    `      Remove-Item -LiteralPath ${psq(options.workDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `      Start-Process -FilePath ${psq(options.executable)}${launchArguments} -WorkingDirectory ${psq(options.runningApp)} -ErrorAction Stop`,
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
    `    Remove-Item -LiteralPath ${psq(options.marker)},${psq(options.phase)},${psq(options.ready)},${psq(options.activated)},${psq(options.armed)} -Force -ErrorAction SilentlyContinue`,
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
  const parentToken = options.parentToken ?? "test-parent-token";
  const replacementIdentity =
    options.replacement ?? join(dirname(options.marker), `.update-replacement-${options.token}`);
  return [
    "set -eu",
    "umask 077",
    `APP=${sh(options.runningApp)}`,
    `NEW=${sh(options.staged)}`,
    `WORK=${sh(options.workDir)}`,
    `HANDOFF=${sh(options.marker)}`,
    `READY=${sh(options.ready)}`,
    `REPLACEMENT=${sh(replacementIdentity)}`,
    `ACTIVATED=${sh(options.activated)}`,
    `ARMED=${sh(options.armed)}`,
    `HELPER_IDENTITY=${sh(join(options.workDir, APPLY_HELPER_PID_FILE))}`,
    `PHASE=${sh(options.phase)}`,
    `SWAP=${sh(options.swapTool)}`,
    `TOKEN=${sh(options.token)}`,
    `PID=${options.pid ?? process.pid}`,
    `PARENT_TOKEN=${sh(parentToken)}`,
    `OLD=${sh(options.backup ?? `${options.runningApp}.mirin-old-${options.pid ?? process.pid}`)}`,
    `EXE=${sh(options.executable)}`,
    "PARENT_EXITED=0",
    "ACCEPTED=0",
    "SWAPPED=0",
    "NEW_PID=",
    "NEW_TOKEN=",
    'durable_remove_state() { if [ -f "$1" ]; then "$SWAP" durable-remove-file "$1"; fi; }',
    'cleanup_handoff() { durable_remove_state "$HANDOFF"; durable_remove_state "$REPLACEMENT"; durable_remove_state "$READY"; durable_remove_state "$PHASE"; durable_remove_state "$ACTIVATED"; durable_remove_state "$ARMED"; }',
    'process_matches() { observed=$("$SWAP" process-token "$1" 2>/dev/null) || return 1; [ "$observed" = "$2" ]; }',
    "stop_replacement() {",
    '  if [ -z "$NEW_PID" ]; then return 0; fi',
    '  if [ -z "$NEW_TOKEN" ]; then wait "$NEW_PID" 2>/dev/null || true; return 0; fi',
    '  "$SWAP" terminate-process "$NEW_PID" "$NEW_TOKEN" || return 1',
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
    "        rollback_swap_status=0",
    '        "$SWAP" atomic-swap "$APP" "$RESTORE" || rollback_swap_status=$?',
    `        if [ "$rollback_swap_status" -eq ${ATOMIC_SWAP_DURABILITY_EXIT_CODE} ]; then`,
    '          "$SWAP" sync-parent "$APP" || restored=0',
    '        elif [ "$rollback_swap_status" -ne 0 ]; then restored=0; fi',
    '        if [ "$restored" -eq 1 ]; then "$SWAP" durable-remove-directory "$RESTORE" || restored=0; fi',
    "      fi",
    '      if [ "$restored" -eq 1 ] && [ -x "$EXE" ]; then',
    '        if [ -d "$NEW" ]; then "$SWAP" durable-remove-directory "$NEW" 2>/dev/null || true; fi',
    "        cleanup_handoff",
    "        relaunch_old",
    '        rm -rf "$WORK" 2>/dev/null || true',
    "      fi",
    "    fi",
    '  elif [ "$ACCEPTED" -eq 0 ]; then',
    "    cleanup_handoff",
    '    rm -rf "$NEW" "$WORK" 2>/dev/null || true',
    "  fi",
    '  exit "$status"',
    "}",
    "trap rollback EXIT HUP INT TERM",
    "cd /",
    'test ! -e "$OLD"',
    'test -d "$APP"',
    'test -d "$NEW"',
    'test -x "$SWAP"',
    'SELF_TOKEN=$("$SWAP" process-token "$$")',
    'BOOT_TOKEN=$("$SWAP" boot-token)',
    'test -n "$BOOT_TOKEN"',
    'SELF_IDENTITY="$$|$SELF_TOKEN"',
    '"$SWAP" durable-write "$HELPER_IDENTITY" "$SELF_IDENTITY"',
    ...(platform === "linux" ? ["command -v setsid >/dev/null 2>&1"] : []),
    "i=0",
    "while :; do",
    '  if [ -f "$ACTIVATED" ]; then',
    '    ACTIVATED_IDENTITY=""',
    '    IFS= read -r ACTIVATED_IDENTITY < "$ACTIVATED" || true',
    '    test "$ACTIVATED_IDENTITY" = "$SELF_IDENTITY"',
    "    break",
    "  fi",
    '  process_matches "$PID" "$PARENT_TOKEN" || exit 1',
    '  if [ "$i" -ge 100 ]; then exit 1; fi',
    "  i=$((i + 1))",
    "  sleep 0.05",
    "done",
    '"$SWAP" durable-write "$PHASE" activated',
    '"$SWAP" durable-write "$ARMED" "$SELF_IDENTITY"',
    "ACCEPTED=1",
    'if ! "$SWAP" wait-process "$PID" "$PARENT_TOKEN" 30000; then',
    '  "$SWAP" terminate-process "$PID" "$PARENT_TOKEN"',
    "fi",
    "PARENT_EXITED=1",
    'rm -f "$READY"',
    '"$SWAP" durable-write "$PHASE" swap-pending',
    "swap_status=0",
    '"$SWAP" atomic-swap "$APP" "$NEW" || swap_status=$?',
    `if [ "$swap_status" -eq ${ATOMIC_SWAP_DURABILITY_EXIT_CODE} ]; then`,
    "  SWAPPED=1",
    '  "$SWAP" sync-parent "$APP"',
    'elif [ "$swap_status" -ne 0 ]; then exit "$swap_status"',
    "else",
    "  SWAPPED=1",
    "fi",
    '"$SWAP" durable-write "$PHASE" backup-pending',
    '"$SWAP" durable-move "$NEW" "$OLD"',
    '"$SWAP" durable-write "$PHASE" backed-up',
    ...(platform === "darwin"
      ? ['xattr -r -d com.apple.quarantine "$APP" 2>/dev/null || true']
      : []),
    '"$SWAP" durable-write "$PHASE" launching',
    '"$SWAP" durable-write "$REPLACEMENT" "pending:$BOOT_TOKEN:launch"',
    "launch_new",
    '"$SWAP" durable-write "$REPLACEMENT" "pending:$BOOT_TOKEN:$NEW_PID"',
    "i=0",
    'while [ "$i" -lt 100 ]; do',
    '  NEW_TOKEN=$("$SWAP" process-token "$NEW_PID" 2>/dev/null) && break',
    "  i=$((i + 1))",
    "  sleep 0.01",
    "done",
    'test -n "$NEW_TOKEN"',
    'READY_IDENTITY="$NEW_PID|$NEW_TOKEN"',
    '"$SWAP" durable-write "$REPLACEMENT" "$READY_IDENTITY"',
    "READY_OK=0",
    "i=0",
    'while [ "$i" -lt 300 ]; do',
    '  if ! process_matches "$NEW_PID" "$NEW_TOKEN"; then break; fi',
    '  READY_PROCESS=""',
    '  if [ -f "$READY" ]; then IFS= read -r READY_PROCESS < "$READY" || true; fi',
    '  if [ "$READY_PROCESS" = "$READY_IDENTITY" ]; then READY_OK=1; break; fi',
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    'test "$READY_OK" -eq 1',
    'process_matches "$NEW_PID" "$NEW_TOKEN"',
    '"$SWAP" durable-write "$PHASE" committed',
    "trap - EXIT HUP INT TERM",
    '"$SWAP" durable-remove-directory "$OLD"',
    "cleanup_handoff",
    'rm -rf "$WORK" 2>/dev/null || true',
    "exit 0",
  ].join("\n");
}

/** Start a detached platform helper that swaps the app after this process exits. */
export async function applyUpdateAndRelaunch(options: ApplyOptions): Promise<void> {
  const runningApp = IS_WINDOWS
    ? join(options.resourcesDir, "..")
    : IS_LINUX
      ? join(options.resourcesDir, "..")
      : join(options.resourcesDir, "..", "..");
  const installedCodec = IS_WINDOWS
    ? join(runningApp, "mirin-codec.exe")
    : IS_LINUX
      ? join(runningApp, "mirin-codec")
      : join(runningApp, "Contents", "MacOS", "mirin-codec");
  const owner = processIdentity(process.pid, installedCodec);
  const handoff = prepareUpdateHandoff(
    options.version.identifier,
    options.targetVersion,
    undefined,
    undefined,
    {
      sourceVersion: options.version.version,
      runningApp,
      staged: options.staged,
    },
    owner,
  );
  const backup = handoff.backup as string;
  try {
    if (IS_WINDOWS) return await applyWindows(options, handoff, backup);
    if (IS_LINUX) {
      await applyLinux(options, handoff, backup);
      return;
    }
    await applyMac(options, handoff, backup);
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
  backup: string,
): Promise<void> {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, `${version.name}.exe`);
  const token = handoff.token;
  const script = join(tmpdir(), `mirin-apply-${token}.ps1`);
  const launchVbs = join(tmpdir(), `mirin-launch-${token}.vbs`);
  const helperFiles = [script, launchVbs];
  const helperPidFile = join(workDir, APPLY_HELPER_PID_FILE);
  const helperLaunchPidFile = join(workDir, APPLY_HELPER_LAUNCH_PID_FILE);
  const activated = join(workDir, APPLY_HELPER_ACTIVATED_FILE);
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  const swapTool = await prepareAtomicSwapTool(
    join(runningApp, "mirin-codec.exe"),
    runningApp,
    staged,
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
      phase: handoff.phasePath as string,
      replacement: handoff.replacementPath,
      swapTool,
      token,
      parentToken: handoff.ownerToken,
    }),
    "utf8",
  );
  writeFileSync(launchVbs, renderWindowsLaunchVbs(script, helperLaunchPidFile), "utf8");

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
    const helperPid = parseHelperPid(readFileSync(helperLaunchPidFile, "utf8"));
    let helperIdentity: UpdateProcessIdentity | undefined;
    let activationAttempted = false;
    try {
      helperIdentity = await waitForHelperIdentity(helperPidFile, helperPid, swapTool);
      activateUpdateHandoff(handoff, helperIdentity);
      activationAttempted = true;
      signalHelperActivation(activated, helperIdentity, swapTool);
      await waitForHelperArmed(armed, helperIdentity, swapTool);
    } catch (error) {
      if (
        helperIdentity &&
        !(await terminateExactProcess(helperIdentity, swapTool)) &&
        activationAttempted
      ) {
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
  backup: string,
): Promise<void> {
  const runningApp = join(resourcesDir, "..");
  const executable = join(runningApp, version.name);
  const activated = join(workDir, APPLY_HELPER_ACTIVATED_FILE);
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  const swapTool = await prepareAtomicSwapTool(
    join(runningApp, "mirin-codec"),
    runningApp,
    staged,
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
      phase: handoff.phasePath as string,
      replacement: handoff.replacementPath,
      swapTool,
      token: handoff.token,
      parentToken: handoff.ownerToken,
    }),
    workDir,
    handoff,
  );
}

async function applyMac(
  { resourcesDir, staged, workDir, version }: ApplyOptions,
  handoff: PreparedUpdateHandoff,
  backup: string,
): Promise<void> {
  const runningApp = join(resourcesDir, "..", "..");
  const executable = join(runningApp, "Contents", "MacOS", version.name);
  const activated = join(workDir, APPLY_HELPER_ACTIVATED_FILE);
  const armed = join(workDir, APPLY_HELPER_ARMED_FILE);
  const swapTool = await prepareAtomicSwapTool(
    join(runningApp, "Contents", "MacOS", "mirin-codec"),
    runningApp,
    staged,
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
      phase: handoff.phasePath as string,
      replacement: handoff.replacementPath,
      swapTool,
      token: handoff.token,
      parentToken: handoff.ownerToken,
    }),
    workDir,
    handoff,
  );
}

export async function spawnShellSwap(
  script: string,
  workDir: string,
  handoff: PreparedUpdateHandoff,
): Promise<void> {
  const helper = Bun.spawn(["/bin/sh", "-c", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const swapTool = join(workDir, ".mirin-atomic-swap");
  let activationAttempted = false;
  let helperIdentity: UpdateProcessIdentity | undefined;
  try {
    helperIdentity = await waitForHelperIdentity(
      join(workDir, APPLY_HELPER_PID_FILE),
      helper.pid,
      swapTool,
    );
    activateUpdateHandoff(handoff, helperIdentity);
    activationAttempted = true;
    signalHelperActivation(join(workDir, APPLY_HELPER_ACTIVATED_FILE), helperIdentity, swapTool);
    await waitForHelperArmed(join(workDir, APPLY_HELPER_ARMED_FILE), helperIdentity, swapTool);
  } catch (error) {
    const terminated =
      helperIdentity === undefined || (await terminateExactProcess(helperIdentity, swapTool));
    if (!terminated && activationAttempted) {
      helper.unref();
      throw new PreservedHelperOwnershipError(error);
    }
    throw error;
  }
  helper.unref();
}

function signalHelperActivation(
  path: string,
  helper: UpdateProcessIdentity,
  swapTool: string,
): void {
  writeDurableIdentity(path, helper, swapTool, "could not durably activate updater helper");
}

function writeDurableIdentity(
  path: string,
  identity: UpdateProcessIdentity,
  swapTool: string,
  failure: string,
): void {
  const result = Bun.spawnSync([swapTool, "durable-write", path, formatProcessIdentity(identity)], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(failure);
}

async function waitForHelperArmed(
  armedPath: string,
  helper: UpdateProcessIdentity,
  swapTool: string,
  isAlive: (identity: UpdateProcessIdentity) => boolean = (identity) =>
    processIdentityMatches(identity, swapTool),
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const metadata = lstatSync(armedPath);
      if (metadata.isFile() && metadata.size > 0 && metadata.size <= 256) {
        const armed = parseProcessIdentity(readFileSync(armedPath, "utf8"));
        if (armed.pid === helper.pid && armed.token === helper.token) {
          if (!isAlive(helper)) {
            throw new Error("updater helper exited after accepting terminal handoff");
          }
          return;
        }
        throw new Error("updater helper armed acknowledgement has the wrong process identity");
      }
    } catch (error) {
      if (error instanceof Error && !("code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (!isAlive(helper)) {
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

async function prepareAtomicSwapTool(
  bundledTool: string,
  runningApp: string,
  staged: string,
  workDir: string,
): Promise<string> {
  const metadata = lstatSync(bundledTool);
  if (!metadata.isFile()) throw new Error("installed atomic updater swap tool is invalid");
  const tool = join(workDir, IS_WINDOWS ? ".mirin-atomic-swap.exe" : ".mirin-atomic-swap");
  copyFileSync(bundledTool, tool, fsConstants.COPYFILE_EXCL);
  if (!IS_WINDOWS) chmodSync(tool, 0o700);

  const validate = Bun.spawn([tool, "validate-swap", runningApp, staged], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await validate.exited) !== 0) {
    throw new Error("installed app and staged update cannot be atomically exchanged");
  }

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

async function waitForHelperIdentity(
  path: string,
  pid: number,
  swapTool: string,
): Promise<UpdateProcessIdentity> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const identity = parseProcessIdentity(readFileSync(path, "utf8"));
      if (identity.pid !== pid || !processIdentityMatches(identity, swapTool)) {
        throw new Error("updater helper identity receipt is not live");
      }
      return identity;
    } catch (error) {
      if (existsSync(path)) throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error("could not identify updater helper process");
}

async function terminateExactProcess(
  identity: UpdateProcessIdentity,
  swapTool: string,
): Promise<boolean> {
  const process = Bun.spawn([swapTool, "terminate-process", String(identity.pid), identity.token], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await process.exited) !== 0) return false;
  return !processIdentityMatches(identity, swapTool);
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
