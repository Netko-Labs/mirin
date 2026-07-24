import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLinuxInstallCanApply,
  renderLinuxApplyShell,
  renderMacApplyShell,
  renderWindowsApplyPowerShell,
  renderWindowsLaunchVbs,
} from "../src/updater/lib/apply.ts";

describe("Windows updater launcher", () => {
  test("propagates Win32_Process.Create status before the app can quit", () => {
    const script = renderWindowsLaunchVbs(
      'C:\\Temp\\Mirin "Update"\\apply.ps1',
      "C:\\Updates\\generation\\.apply-helper.pid",
    );
    expect(script).toContain('status = GetObject("winmgmts:Win32_Process").Create');
    expect(script).toContain("powershell.exe");
    expect(script).not.toContain("wscript.exe //B");
    expect(script).toContain("If status <> 0 Then WScript.Quit status");
    expect(script).toContain("CreateTextFile");
    expect(script).toContain(".apply-helper.pid");
    expect(script).toContain("Win32_Process.Handle=");
    expect(script).toContain(".Terminate");
    expect(script).toContain("WScript.Quit 0");
    expect(script).toContain('""Update""');
  });

  test("uses literal paths and commits only after the exact replacement reports ready", () => {
    const script = renderWindowsApplyPowerShell({
      runningApp: "C:\\Apps\\[beta]\\Mirin",
      staged: "C:\\Apps\\[beta]\\.Mirin.mirin-new-42-token",
      workDir: "C:\\Updates\\generation",
      executable: "C:\\Apps\\[beta]\\Mirin\\Mirin.exe",
      backup: "C:\\Apps\\[beta]\\Mirin.old",
      helperFiles: ["C:\\Temp\\apply.ps1", "C:\\Temp\\apply.vbs"],
      marker: "C:\\State\\.update-handoff.json",
      ready: "C:\\State\\.update-ready-42-token",
      armed: "C:\\Updates\\generation\\.apply-helper-armed",
      token: "42-00000000-0000-0000-0000-000000000000",
      pid: 42,
    });
    const launch = script.indexOf("Start-Process -FilePath");
    const readiness = script.indexOf("Replacement did not report ready", launch);
    expect(launch).toBeGreaterThan(0);
    expect(readiness).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Updates\\generation", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Apps\\[beta]\\Mirin.old", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\State\\.update-handoff.json", readiness)).toBeGreaterThan(readiness);
    expect(script).toContain("Updater backup path already exists");
    expect(script).toContain("Replacement readiness receipt has the wrong process id");
    expect(script).toContain("$readyPid -ne [string]$newProcess.Id");
    expect(script.indexOf(".apply-helper-armed")).toBeLessThan(script.indexOf("$parentDeadline"));
    const rollback = script.indexOf("if ($parentExited -and $canRestore)");
    const rollbackCleanup = script.indexOf(
      "Remove-Item -LiteralPath 'C:\\Updates\\generation' -Recurse",
      rollback,
    );
    const rollbackRelaunch = script.indexOf("Start-Process -FilePath", rollbackCleanup);
    expect(rollback).toBeGreaterThan(0);
    expect(rollbackCleanup).toBeGreaterThan(rollback);
    expect(rollbackRelaunch).toBeGreaterThan(rollbackCleanup);
    for (const line of script.split("\n")) {
      if (/\b(?:Test-Path|Get-Content|Move-Item|Remove-Item)\b/.test(line)) {
        expect(line).toContain("-LiteralPath");
      }
    }
    if (process.platform === "win32") {
      const parsed = Bun.spawnSync({
        cmd: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[void][scriptblock]::Create($env:MIRIN_TEST_SCRIPT)",
        ],
        env: { ...process.env, MIRIN_TEST_SCRIPT: script },
      });
      expect(parsed.exitCode).toBe(0);
    }
  });
});

describe("POSIX updater helpers", () => {
  test("macOS retains the backup through open and restores and reopens on failure", () => {
    const script = renderMacApplyShell({
      runningApp: "/Applications/Mirin App.app",
      staged: "/tmp/generation/extract/Mirin App.app",
      workDir: "/tmp/generation",
      executable: "/Applications/Mirin App.app/Contents/MacOS/Mirin App",
      marker: "/tmp/state/.update-handoff.json",
      ready: "/tmp/state/.update-ready-42-token",
      armed: "/tmp/generation/.apply-helper-armed",
      token: "42-00000000-0000-0000-0000-000000000000",
      pid: 42,
    });
    const launch = script.indexOf('nohup "$EXE"');
    const readiness = script.indexOf('[ -f "$READY" ]', launch);
    const deleteBackup = script.indexOf('rm -rf "$OLD"', readiness);
    const restoreBackup = script.indexOf('mv "$OLD" "$APP"', launch);
    const reopenOld = script.indexOf("then relaunch_old", restoreBackup);
    expect(launch).toBeGreaterThan(0);
    expect(readiness).toBeGreaterThan(launch);
    expect(deleteBackup).toBeGreaterThan(readiness);
    expect(restoreBackup).toBeGreaterThan(launch);
    expect(reopenOld).toBeGreaterThan(restoreBackup);
    expect(script.indexOf('rm -rf "$WORK"', readiness)).toBeGreaterThan(readiness);
    expect(script).toContain('if [ "$READY_PID" = "$NEW_PID" ]');
    expect(script).toContain('kill -KILL "$NEW_PID"');
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
    }
  });

  test("Linux observes immediate launch failure before deleting the backup and generation", () => {
    const script = renderLinuxApplyShell({
      runningApp: "/opt/Mirin App",
      staged: "/tmp/generation/extract/Mirin App",
      workDir: "/tmp/generation",
      executable: "/opt/Mirin App/Mirin App",
      marker: "/tmp/state/.update-handoff.json",
      ready: "/tmp/state/.update-ready-42-token",
      armed: "/tmp/generation/.apply-helper-armed",
      token: "42-00000000-0000-0000-0000-000000000000",
      pid: 42,
    });
    const launch = script.indexOf("setsid ");
    const readiness = script.indexOf('[ -f "$READY" ]', launch);
    expect(launch).toBeGreaterThan(0);
    expect(readiness).toBeGreaterThan(launch);
    expect(script.indexOf('kill -0 "$NEW_PID"', launch)).toBeGreaterThan(launch);
    expect(script.indexOf('mv "$OLD" "$APP"', launch)).toBeGreaterThan(launch);
    expect(script.indexOf('rm -rf "$OLD"', readiness)).toBeGreaterThan(readiness);
    expect(script.indexOf('rm -rf "$WORK"', readiness)).toBeGreaterThan(readiness);
    expect(script.indexOf('printf "%s" "$$" > "$ARMED"')).toBeLessThan(
      script.indexOf('while kill -0 "$PID"'),
    );
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
    }
  });

  test("an accepted helper restores the old app after replacement startup fails", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "mirin-helper-rollback-"));
    const runningApp = join(root, "Mirin.app");
    const staged = join(root, ".Mirin.app.mirin-new-42-token");
    const workDir = join(root, "work");
    const marker = join(root, ".update-handoff.json");
    const ready = join(root, ".update-ready-42-token");
    const armed = join(workDir, ".apply-helper-armed");
    const executable = join(runningApp, "Contents", "MacOS", "Mirin");
    const stagedExecutable = join(staged, "Contents", "MacOS", "Mirin");
    try {
      mkdirSync(join(runningApp, "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(staged, "Contents", "MacOS"), { recursive: true });
      mkdirSync(workDir);
      writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      writeFileSync(stagedExecutable, "#!/bin/sh\nexit 1\n");
      writeFileSync(join(runningApp, "old-sentinel"), "old");
      writeFileSync(join(staged, "new-sentinel"), "new");
      writeFileSync(marker, "{}");
      chmodSync(executable, 0o755);
      chmodSync(stagedExecutable, 0o755);

      const script = renderMacApplyShell({
        runningApp,
        staged,
        workDir,
        executable,
        marker,
        ready,
        armed,
        token: "42-00000000-0000-0000-0000-000000000000",
        pid: 2_147_483_647,
      });
      const helper = Bun.spawn(["/bin/sh", "-c", script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await helper.exited).not.toBe(0);
      expect(existsSync(join(runningApp, "old-sentinel"))).toBe(true);
      expect(existsSync(join(runningApp, "new-sentinel"))).toBe(false);
      expect(existsSync(`${runningApp}.mirin-old-2147483647`)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects AppImage and non-writable package installs before handoff", () => {
    expect(() =>
      assertLinuxInstallCanApply("/mount/usr/lib/app/resources", "/tmp/App.AppImage"),
    ).toThrow("AppImage");
    expect(() =>
      assertLinuxInstallCanApply("/opt/app/resources", undefined, () => {
        throw new Error("read-only");
      }),
    ).toThrow("system package manager");
    expect(() =>
      assertLinuxInstallCanApply(
        "/home/user/app/resources",
        undefined,
        () => "/home/user/.mirin-update-probe-test",
        () => {},
      ),
    ).not.toThrow();
  });
});
