import { describe, expect, test } from "bun:test";
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

  test("cleans the backup and generation only after relaunch succeeds", () => {
    const script = renderWindowsApplyPowerShell({
      runningApp: "C:\\Apps\\Mirin",
      staged: "C:\\Updates\\generation\\extract\\Mirin",
      workDir: "C:\\Updates\\generation",
      executable: "C:\\Apps\\Mirin\\Mirin.exe",
      backup: "C:\\Apps\\Mirin.old",
      helperFiles: ["C:\\Temp\\apply.ps1", "C:\\Temp\\apply.vbs"],
      marker: "C:\\State\\.update-handoff.json",
      ready: "C:\\State\\.update-ready-42-token",
      pid: 42,
    });
    const launch = script.indexOf("Start-Process -FilePath");
    const readiness = script.indexOf("Replacement did not report ready", launch);
    expect(launch).toBeGreaterThan(0);
    expect(readiness).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Updates\\generation", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Apps\\Mirin.old", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\State\\.update-handoff.json", readiness)).toBeGreaterThan(readiness);
    expect(script).toContain("Updater backup path already exists");
    expect(script).toContain(
      "if ((Test-Path 'C:\\Apps\\Mirin') -or -not (Test-Path 'C:\\Apps\\Mirin.old'))",
    );
    expect(script).toContain(
      "Remove-Item -Recurse -Force 'C:\\Apps\\Mirin' -ErrorAction SilentlyContinue",
    );
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
      pid: 42,
    });
    const launch = script.indexOf('nohup "$EXE"');
    const readiness = script.indexOf('[ -f "$READY" ]', launch);
    const deleteBackup = script.indexOf('rm -rf "$OLD"', readiness);
    const restoreBackup = script.indexOf('mv "$OLD" "$APP"', launch);
    const reopenOld = script.indexOf('open "$APP" || true', launch);
    expect(launch).toBeGreaterThan(0);
    expect(readiness).toBeGreaterThan(launch);
    expect(deleteBackup).toBeGreaterThan(readiness);
    expect(restoreBackup).toBeGreaterThan(launch);
    expect(reopenOld).toBeGreaterThan(restoreBackup);
    expect(script.indexOf('rm -rf "$WORK"')).toBeGreaterThan(readiness);
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
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
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
