import { describe, expect, test } from "bun:test";
import { renderWindowsLaunchVbs } from "../src/updater/lib/apply.ts";

describe("Windows updater launcher", () => {
  test("propagates Win32_Process.Create status before the app can quit", () => {
    const script = renderWindowsLaunchVbs('C:\\Temp\\Mirin "Update"\\apply.vbs');
    expect(script).toContain('status = GetObject("winmgmts:Win32_Process").Create');
    expect(script).toContain("If status <> 0 Then WScript.Quit status");
    expect(script).toContain("WScript.Quit 0");
    expect(script).toContain('""Update""');
  });
});
