import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionInfo } from "../types.ts";
import { IS_LINUX, IS_WINDOWS, psq, sh } from "./platform.ts";

interface ApplyOptions {
  resourcesDir: string;
  staged: string;
  version: VersionInfo;
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

async function applyWindows({ resourcesDir, staged, version }: ApplyOptions): Promise<void> {
  const runningApp = join(resourcesDir, "..");
  const exe = join(runningApp, `${version.name}.exe`);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const script = join(tmpdir(), `mirin-apply-${token}.ps1`);
  const applyVbs = join(tmpdir(), `mirin-apply-${token}.vbs`);
  const launchVbs = join(tmpdir(), `mirin-launch-${token}.vbs`);
  const backup = `${runningApp}.mirin-old-${process.pid}`;
  const ps = [
    "$ErrorActionPreference='Stop'",
    "Set-Location $env:TEMP",
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }`,
    "Start-Sleep -Milliseconds 700",
    `Remove-Item -Recurse -Force ${psq(backup)} -ErrorAction SilentlyContinue`,
    `for ($i=0; $i -lt 50; $i++) { Move-Item ${psq(runningApp)} ${psq(backup)} -ErrorAction SilentlyContinue; if (Test-Path ${psq(backup)}) { break }; Start-Sleep -Milliseconds 200 }`,
    `if (-not (Test-Path ${psq(backup)})) { throw 'Could not unlock the existing app' }`,
    "try {",
    `  Move-Item ${psq(staged)} ${psq(runningApp)}`,
    "} catch {",
    `  Move-Item ${psq(backup)} ${psq(runningApp)} -ErrorAction SilentlyContinue`,
    "  throw",
    "}",
    `Remove-Item -Recurse -Force ${psq(backup)} -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(runningApp)}`,
    `Remove-Item -Force ${psq(script)},${psq(applyVbs)},${psq(launchVbs)} -ErrorAction SilentlyContinue`,
  ].join("\n");
  writeFileSync(script, ps, "utf8");

  // wscript is a GUI-subsystem host, so PowerShell never flashes a console.
  writeFileSync(
    applyVbs,
    `CreateObject("WScript.Shell").Run "powershell -NoProfile -NonInteractive ` +
      `-ExecutionPolicy Bypass -WindowStyle Hidden -File ""${script}""", 0, False\n`,
    "utf8",
  );

  // WMI owns the swap process, allowing it to outlive the Bun host's job object.
  writeFileSync(
    launchVbs,
    `GetObject("winmgmts:Win32_Process").Create ` +
      `"wscript.exe //B //Nologo ""${applyVbs}""", Null, Null, pid\n`,
    "utf8",
  );
  const launcher = Bun.spawn(["wscript.exe", "//B", "//Nologo", launchVbs], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await launcher.exited;
  if (exitCode !== 0) throw new Error(`failed to launch Windows updater (${exitCode})`);
}

function applyLinux({ resourcesDir, staged, version }: ApplyOptions): void {
  const runningApp = join(resourcesDir, "..");
  const binary = join(runningApp, version.name);
  spawnShellSwap(runningApp, staged, [
    `chmod +x ${sh(binary)} 2>/dev/null || true`,
    `setsid ${sh(binary)} >/dev/null 2>&1 < /dev/null &`,
  ]);
}

function applyMac({ resourcesDir, staged }: ApplyOptions): void {
  const runningApp = join(resourcesDir, "..", "..");
  spawnShellSwap(runningApp, staged, [
    `xattr -r -d com.apple.quarantine "$APP" 2>/dev/null || true`,
    `open "$APP"`,
  ]);
}

function spawnShellSwap(runningApp: string, staged: string, relaunch: string[]): void {
  const script = [
    "set -eu",
    `APP=${sh(runningApp)}`,
    `NEW=${sh(staged)}`,
    `PID=${process.pid}`,
    'OLD="$APP.mirin-old-$PID"',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    "sleep 0.3",
    'rm -rf "$OLD"',
    'mv "$APP" "$OLD"',
    'if mv "$NEW" "$APP"; then',
    '  rm -rf "$OLD"',
    "else",
    '  mv "$OLD" "$APP"',
    "  exit 1",
    "fi",
    ...relaunch,
  ].join("\n");
  Bun.spawn(["/bin/sh", "-c", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}
