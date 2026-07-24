import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { activateUpdateRecovery, type UpdateHandoffRecovery } from "./update-handoff.ts";
import {
  bundledCodecPath,
  formatProcessIdentity,
  parseProcessIdentity,
  processIdentityMatches,
  type UpdateProcessIdentity,
} from "./update-process.ts";
import { psq, sh } from "./updater/lib/platform.ts";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function finalizeCommittedUpdateRecovery(recovery: UpdateHandoffRecovery): void {
  if (recovery.mode !== "commit") {
    throw new Error("cannot finalize an uncommitted updater recovery");
  }
  const tool = prepareRecoveryTool(recovery);
  for (const path of [recovery.backup, recovery.staged]) {
    if (realDirectory(path)) {
      runCodec(
        tool,
        ["durable-remove-directory", path],
        "could not remove committed updater backup",
      );
    }
  }
  for (const path of recovery.claimPaths) removeStateFileDurably(tool, path);
  removeStateFileDurably(tool, recovery.markerPath);
  removeStateFileDurably(tool, recovery.replacementPath);
  removeStateFileDurably(tool, recovery.readyPath);
  removeStateFileDurably(tool, recovery.phasePath);
  removeFileBestEffort(tool);
}

export function launchRollbackUpdateRecovery(
  recovery: UpdateHandoffRecovery,
  executable = process.execPath,
): void {
  if (recovery.mode !== "rollback" || !recovery.restorePath) {
    throw new Error("updater rollback recovery is incomplete");
  }
  const executableRelative = relative(recovery.runningApp, executable);
  if (
    !executableRelative ||
    isAbsolute(executableRelative) ||
    executableRelative === ".." ||
    executableRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(recovery.runningApp, executableRelative) !== resolve(executable)
  ) {
    throw new Error("updater recovery executable is outside the installed app");
  }

  const state = dirname(recovery.markerPath);
  const tool = prepareRecoveryTool(recovery);
  const extension = process.platform === "win32" ? "ps1" : "sh";
  const script = join(state, `.update-recovery-${recovery.token}-${randomUUID()}.${extension}`);
  const activated = join(state, `.update-recovery-activated-${recovery.token}`);
  const armed = join(state, `.update-recovery-armed-${recovery.token}`);
  const identity = join(state, `.update-recovery-identity-${recovery.token}-${randomUUID()}`);
  writeFileSync(
    script,
    process.platform === "win32"
      ? renderWindowsRecovery(
          recovery,
          tool,
          executableRelative,
          activated,
          armed,
          identity,
          script,
        )
      : renderPosixRecovery(recovery, tool, executableRelative, activated, armed, identity, script),
    { encoding: "utf8", flag: "wx", mode: 0o700 },
  );
  if (process.platform !== "win32") chmodSync(script, 0o700);

  const helper =
    process.platform === "win32"
      ? Bun.spawn(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        )
      : Bun.spawn(["/bin/sh", script], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });

  let helperIdentity: UpdateProcessIdentity | undefined;
  try {
    helperIdentity = waitForIdentity(identity, helper.pid, tool);
    activateUpdateRecovery(recovery, helperIdentity);
    runCodec(
      tool,
      ["durable-write", activated, formatProcessIdentity(helperIdentity)],
      "could not activate updater recovery helper",
    );
    waitForArmed(armed, helperIdentity, tool);
    for (const path of recovery.claimPaths) removeStateFileDurably(tool, path);
  } catch (error) {
    if (helperIdentity) {
      Bun.spawnSync([tool, "terminate-process", String(helperIdentity.pid), helperIdentity.token], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    removeFileBestEffort(script);
    removeFileBestEffort(activated);
    removeFileBestEffort(armed);
    removeFileBestEffort(identity);
    throw error;
  }
  helper.unref();
}

function renderPosixRecovery(
  recovery: UpdateHandoffRecovery,
  tool: string,
  executableRelative: string,
  activated: string,
  armed: string,
  identity: string,
  script: string,
): string {
  const executable = join(recovery.runningApp, executableRelative);
  const restorePath = recovery.restorePath as string;
  return [
    "set -eu",
    "umask 077",
    `APP=${sh(recovery.runningApp)}`,
    `RESTORE=${sh(restorePath)}`,
    `TOOL=${sh(tool)}`,
    `MARKER=${sh(recovery.markerPath)}`,
    `PHASE=${sh(recovery.phasePath)}`,
    `READY=${sh(recovery.readyPath)}`,
    `REPLACEMENT=${sh(recovery.replacementPath)}`,
    `ACTIVATED=${sh(activated)}`,
    `ARMED=${sh(armed)}`,
    `IDENTITY=${sh(identity)}`,
    `SCRIPT=${sh(script)}`,
    `OWNER_PID=${recovery.owner.pid}`,
    `OWNER_TOKEN=${sh(recovery.owner.token)}`,
    `EXE=${sh(executable)}`,
    'SELF_TOKEN=$("$TOOL" process-token "$$")',
    'SELF_IDENTITY="$$|$SELF_TOKEN"',
    '"$TOOL" durable-write "$IDENTITY" "$SELF_IDENTITY"',
    "i=0",
    "while :; do",
    '  if [ -f "$ACTIVATED" ]; then',
    '    value=""; IFS= read -r value < "$ACTIVATED" || true',
    '    test "$value" = "$SELF_IDENTITY"',
    "    break",
    "  fi",
    '  observed=$("$TOOL" process-token "$OWNER_PID" 2>/dev/null) || exit 1',
    '  test "$observed" = "$OWNER_TOKEN"',
    '  test "$i" -lt 200',
    "  i=$((i + 1))",
    "  sleep 0.025",
    "done",
    '"$TOOL" durable-write "$ARMED" "$SELF_IDENTITY"',
    'if ! "$TOOL" wait-process "$OWNER_PID" "$OWNER_TOKEN" 30000; then',
    '  "$TOOL" terminate-process "$OWNER_PID" "$OWNER_TOKEN"',
    "fi",
    ...(recovery.replacement
      ? [
          `if ! "$TOOL" wait-process ${recovery.replacement.pid} ${sh(recovery.replacement.token)} 0; then`,
          `  "$TOOL" terminate-process ${recovery.replacement.pid} ${sh(recovery.replacement.token)}`,
          "fi",
        ]
      : []),
    '"$TOOL" atomic-swap "$APP" "$RESTORE"',
    '"$TOOL" durable-remove-directory "$RESTORE"',
    ...recovery.claimPaths.map(
      (path) => `if [ -f ${sh(path)} ]; then "$TOOL" durable-remove-file ${sh(path)}; fi`,
    ),
    'if [ -f "$MARKER" ]; then "$TOOL" durable-remove-file "$MARKER"; fi',
    'if [ -f "$REPLACEMENT" ]; then "$TOOL" durable-remove-file "$REPLACEMENT"; fi',
    'if [ -f "$READY" ]; then "$TOOL" durable-remove-file "$READY"; fi',
    'if [ -f "$PHASE" ]; then "$TOOL" durable-remove-file "$PHASE"; fi',
    'rm -f "$ACTIVATED" "$ARMED" "$IDENTITY" "$TOOL"',
    ...(process.platform === "darwin"
      ? ['open "$APP" >/dev/null 2>&1 || "$EXE" >/dev/null 2>&1 &']
      : ['setsid "$EXE" >/dev/null 2>&1 < /dev/null &']),
    'rm -f "$SCRIPT"',
    "exit 0",
    "",
  ].join("\n");
}

function renderWindowsRecovery(
  recovery: UpdateHandoffRecovery,
  tool: string,
  executableRelative: string,
  activated: string,
  armed: string,
  identity: string,
  script: string,
): string {
  const executable = join(recovery.runningApp, executableRelative);
  const restorePath = recovery.restorePath as string;
  return [
    "$ErrorActionPreference='Stop'",
    `$tool=${psq(tool)}`,
    "$selfToken=(& $tool process-token ([string]$PID)).Trim()",
    "$selfIdentity=[string]$PID+'|'+$selfToken",
    `& $tool durable-write ${psq(identity)} $selfIdentity`,
    "if ($LASTEXITCODE -ne 0) { throw 'Could not publish updater recovery identity' }",
    "$deadline=(Get-Date).AddSeconds(5)",
    "while ($true) {",
    `  if (Test-Path -LiteralPath ${psq(activated)} -PathType Leaf) {`,
    `    $value=(Get-Content -LiteralPath ${psq(activated)} -Raw).Trim()`,
    "    if ($value -ne $selfIdentity) { throw 'Updater recovery activation identity mismatch' }",
    "    break",
    "  }",
    `  $owner=(& $tool process-token ${psq(String(recovery.owner.pid))} 2>$null).Trim()`,
    `  if ($LASTEXITCODE -ne 0 -or $owner -ne ${psq(recovery.owner.token)}) { throw 'Updater recovery owner exited before activation' }`,
    "  if ((Get-Date) -ge $deadline) { throw 'Updater recovery was not activated' }",
    "  Start-Sleep -Milliseconds 25",
    "}",
    `& $tool durable-write ${psq(armed)} $selfIdentity`,
    "if ($LASTEXITCODE -ne 0) { throw 'Could not publish updater recovery acceptance' }",
    `& $tool wait-process ${psq(String(recovery.owner.pid))} ${psq(recovery.owner.token)} '30000'`,
    "if ($LASTEXITCODE -ne 0) {",
    `  & $tool terminate-process ${psq(String(recovery.owner.pid))} ${psq(recovery.owner.token)}`,
    "  if ($LASTEXITCODE -ne 0) { throw 'Could not stop updater recovery owner' }",
    "}",
    ...(recovery.replacement
      ? [
          `& $tool wait-process ${psq(String(recovery.replacement.pid))} ${psq(recovery.replacement.token)} '0'`,
          "if ($LASTEXITCODE -ne 0) {",
          `  & $tool terminate-process ${psq(String(recovery.replacement.pid))} ${psq(recovery.replacement.token)}`,
          "  if ($LASTEXITCODE -ne 0) { throw 'Could not stop live replacement before recovery' }",
          "}",
        ]
      : []),
    `& $tool atomic-swap ${psq(recovery.runningApp)} ${psq(restorePath)}`,
    "if ($LASTEXITCODE -ne 0) { throw 'Could not restore previous app' }",
    `& $tool durable-remove-directory ${psq(restorePath)}`,
    "if ($LASTEXITCODE -ne 0) { throw 'Could not remove failed replacement' }",
    ...recovery.claimPaths.map(
      (path) =>
        `if (Test-Path -LiteralPath ${psq(path)} -PathType Leaf) { & $tool durable-remove-file ${psq(path)} }`,
    ),
    `if (Test-Path -LiteralPath ${psq(recovery.markerPath)} -PathType Leaf) { & $tool durable-remove-file ${psq(recovery.markerPath)} }`,
    `if (Test-Path -LiteralPath ${psq(recovery.replacementPath)} -PathType Leaf) { & $tool durable-remove-file ${psq(recovery.replacementPath)} }`,
    `if (Test-Path -LiteralPath ${psq(recovery.readyPath)} -PathType Leaf) { & $tool durable-remove-file ${psq(recovery.readyPath)} }`,
    `if (Test-Path -LiteralPath ${psq(recovery.phasePath)} -PathType Leaf) { & $tool durable-remove-file ${psq(recovery.phasePath)} }`,
    `Remove-Item -LiteralPath ${psq(activated)},${psq(armed)},${psq(identity)} -Force -ErrorAction SilentlyContinue`,
    "Remove-Item -LiteralPath $tool -Force -ErrorAction SilentlyContinue",
    `Start-Process -FilePath ${psq(executable)} -WorkingDirectory ${psq(recovery.runningApp)} -ErrorAction Stop`,
    `Remove-Item -LiteralPath ${psq(script)} -Force -ErrorAction SilentlyContinue`,
  ].join("\n");
}

function prepareRecoveryTool(recovery: UpdateHandoffRecovery): string {
  const source = bundledCodecPath();
  const target = join(
    dirname(recovery.markerPath),
    `.update-recovery-codec-${recovery.token}${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (existsSync(target)) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("updater recovery tool path is unsafe");
    }
    if (filesMatch(source, target)) return target;
    rmSync(target);
  }
  try {
    copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
    if (process.platform !== "win32") chmodSync(target, 0o700);
    runCodec(source, ["sync-tree", target], "could not make updater recovery tool durable");
    if (!filesMatch(source, target)) throw new Error("updater recovery tool copy is invalid");
    return target;
  } catch (error) {
    removeFileBestEffort(target);
    throw error;
  }
}

function runCodec(tool: string, args: string[], failure: string): void {
  const result = Bun.spawnSync([tool, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(failure);
}

function removeStateFileDurably(tool: string, path: string): void {
  if (!existsSync(path)) return;
  runCodec(tool, ["durable-remove-file", path], "could not clear updater recovery state");
}

function waitForIdentity(path: string, pid: number, tool: string): UpdateProcessIdentity {
  for (let index = 0; index < 200; index += 1) {
    try {
      const identity = parseProcessIdentity(readFileSync(path, "utf8"));
      if (identity.pid !== pid || !processIdentityMatches(identity, tool)) {
        throw new Error("updater recovery helper identity is not live");
      }
      return identity;
    } catch (error) {
      if (existsSync(path)) throw error;
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, 25);
  }
  throw new Error("could not identify updater recovery helper");
}

function waitForArmed(path: string, helper: UpdateProcessIdentity, tool: string): void {
  for (let index = 0; index < 200; index += 1) {
    try {
      const identity = parseProcessIdentity(readFileSync(path, "utf8"));
      if (identity.pid !== helper.pid || identity.token !== helper.token) {
        throw new Error("updater recovery helper acceptance identity mismatch");
      }
      if (!processIdentityMatches(helper, tool)) {
        throw new Error("updater recovery helper exited after accepting ownership");
      }
      return;
    } catch (error) {
      if (existsSync(path)) throw error;
    }
    if (!processIdentityMatches(helper, tool)) {
      throw new Error("updater recovery helper exited before accepting ownership");
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, 25);
  }
  throw new Error("updater recovery helper did not accept ownership");
}

function realDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return !metadata.isSymbolicLink() && metadata.isDirectory();
  } catch {
    return false;
  }
}

function filesMatch(left: string, right: string): boolean {
  try {
    const leftMetadata = lstatSync(left);
    const rightMetadata = lstatSync(right);
    if (
      leftMetadata.isSymbolicLink() ||
      rightMetadata.isSymbolicLink() ||
      !leftMetadata.isFile() ||
      !rightMetadata.isFile() ||
      leftMetadata.size !== rightMetadata.size
    ) {
      return false;
    }
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    return digest(left) === digest(right);
  } catch {
    return false;
  }
}

function removeFileBestEffort(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The durable transaction marker makes leftover helper files recoverable.
  }
}
