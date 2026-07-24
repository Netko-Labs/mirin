import { describe, expect, test } from "bun:test";
import {
  renderLinuxApplyShell,
  renderMacApplyShell,
  renderWindowsApplyPowerShell,
  renderWindowsLaunchVbs,
} from "../src/updater/lib/apply.ts";

describe("Windows updater launcher", () => {
  test("propagates Win32_Process.Create status before the app can quit", () => {
    const script = renderWindowsLaunchVbs(
      'C:\\Temp\\Mirin "Update"\\apply.vbs',
      "C:\\Updates\\generation\\.apply-helper.pid",
    );
    expect(script).toContain('status = GetObject("winmgmts:Win32_Process").Create');
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
      pid: 42,
    });
    const launch = script.indexOf("Start-Process -FilePath");
    expect(launch).toBeGreaterThan(0);
    expect(script.indexOf("C:\\Updates\\generation", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Apps\\Mirin.old", launch)).toBeGreaterThan(launch);
    expect(script).toContain("Updater backup path already exists");
    expect(script).toContain(
      "if ((Test-Path 'C:\\Apps\\Mirin') -or -not (Test-Path 'C:\\Apps\\Mirin.old'))",
    );
    expect(script).toContain(
      "Remove-Item -Recurse -Force 'C:\\Apps\\Mirin' -ErrorAction SilentlyContinue",
    );
  });
});

describe("POSIX updater helpers", () => {
  test("macOS retains the backup through open and restores and reopens on failure", () => {
    const script = renderMacApplyShell({
      runningApp: "/Applications/Mirin App.app",
      staged: "/tmp/generation/extract/Mirin App.app",
      workDir: "/tmp/generation",
      pid: 42,
    });
    const firstOpen = script.indexOf('if open "$APP"; then');
    const deleteBackup = script.indexOf('rm -rf "$OLD"', firstOpen);
    const restoreBackup = script.indexOf('mv "$OLD" "$APP"', firstOpen);
    const reopenOld = script.indexOf('open "$APP" || true', firstOpen);
    expect(firstOpen).toBeGreaterThan(0);
    expect(deleteBackup).toBeGreaterThan(firstOpen);
    expect(restoreBackup).toBeGreaterThan(firstOpen);
    expect(reopenOld).toBeGreaterThan(restoreBackup);
    expect(script.indexOf('rm -rf "$WORK"')).toBeGreaterThan(firstOpen);
  });

  test("Linux observes immediate launch failure before deleting the backup and generation", () => {
    const script = renderLinuxApplyShell({
      runningApp: "/opt/Mirin App",
      staged: "/tmp/generation/extract/Mirin App",
      workDir: "/tmp/generation",
      executable: "/opt/Mirin App/Mirin App",
      pid: 42,
    });
    const launch = script.indexOf("setsid ");
    expect(launch).toBeGreaterThan(0);
    expect(script.indexOf('kill -0 "$NEW_PID"', launch)).toBeGreaterThan(launch);
    expect(script.indexOf('mv "$OLD" "$APP"', launch)).toBeGreaterThan(launch);
    expect(script.indexOf('rm -rf "$OLD"', launch)).toBeGreaterThan(launch);
    expect(script.indexOf('rm -rf "$WORK"', launch)).toBeGreaterThan(launch);
  });
});
