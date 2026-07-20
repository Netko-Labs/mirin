import { describe, expect, test } from "bun:test";
import { type RenderNsisInput, renderNsisScript } from "../src/installer-win.ts";

const base: RenderNsisInput = {
  appDir: "C:\\build path\\Safe App",
  appName: "Safe App",
  exeName: "Safe App.exe",
  version: "1.2.3",
  channel: "stable",
  bundleId: "dev.example.safe-app",
  outDir: "C:\\release path",
  out: "C:\\release path\\stable-win32-x64-SafeApp-setup.exe",
  fileName: "stable-win32-x64-SafeApp-setup.exe",
  options: {},
  projectDir: "C:\\project path",
};

describe("NSIS script rendering", () => {
  test("cleans the owned app directory before overlay and quotes executable commands", () => {
    const script = renderNsisScript(base);
    const cleanup = script.indexOf("  Call CleanupLegacyFlatPayload");
    const removeApp = script.indexOf('  RMDir /r "$INSTDIR\\app"', cleanup);
    const setOutPath = script.indexOf('  SetOutPath "$INSTDIR\\app"', removeApp);
    const copyPayload = script.indexOf('File /r "C:\\build path\\Safe App\\*"', setOutPath);

    expect(cleanup).toBeGreaterThan(-1);
    expect(removeApp).toBeGreaterThan(cleanup);
    expect(setOutPath).toBeGreaterThan(removeApp);
    expect(copyPayload).toBeGreaterThan(setOutPath);
    expect(script).toContain('File /r "C:\\build path\\Safe App\\*"');
    expect(script).toContain(
      'CreateShortcut "$DESKTOP\\Safe App.lnk" "$INSTDIR\\app\\Safe App.exe"',
    );
    expect(script).toContain('"UninstallString" \'"$INSTDIR\\Uninstall.exe"\'');
    expect(script).toContain('"QuietUninstallString" \'"$INSTDIR\\Uninstall.exe" /S\'');
    expect(script).toContain('"DisplayIcon" "$INSTDIR\\app\\Safe App.exe"');
  });

  test("uninstalls only owned entries and removes the root non-recursively", () => {
    const lines = renderNsisScript(base).split("\n");

    expect(lines).toContain('  RMDir /r "$INSTDIR\\app"');
    expect(lines).toContain('  Delete "$INSTDIR\\Uninstall.exe"');
    expect(lines).toContain('  RMDir "$INSTDIR"');
    expect(lines).not.toContain('  RMDir /r "$INSTDIR"');
    expect(lines.some((line) => line.includes("DeleteRegKey HKCU"))).toBe(true);
  });

  test("guards exact legacy flat cleanup and provides an uninstall fallback", () => {
    const script = renderNsisScript({
      ...base,
      legacyRootFiles: ["removed-runtime.dll"],
    });

    expect(script).toContain("Function CleanupLegacyFlatPayload");
    expect(script).toContain("Function un.CleanupLegacyFlatPayload");
    expect(script).toContain('IfFileExists "$INSTDIR\\Safe App.exe" 0 .done');
    expect(script).toContain('IfFileExists "$INSTDIR\\mirin_core.dll" 0 .done');
    expect(script).toContain('IfFileExists "$INSTDIR\\mirin-helper.exe" 0 .done');
    expect(script).toContain('IfFileExists "$INSTDIR\\libcef.dll" 0 .done');
    expect(script).toContain('IfFileExists "$INSTDIR\\resources\\mirin.manifest.json" 0 .done');
    expect(script).toContain('  Delete "$INSTDIR\\removed-runtime.dll"');
    expect(script).not.toContain('  Delete "$INSTDIR\\sentinel.txt"');
    expect(script).toContain('  RMDir /r "$INSTDIR\\resources"');
    expect(script).toContain('  RMDir /r "$INSTDIR\\locales"');
    expect(script).not.toContain('RMDir /r "$INSTDIR"');

    const uninstallSection = script.indexOf('Section "Uninstall"');
    const fallback = script.indexOf("  Call un.CleanupLegacyFlatPayload", uninstallSection);
    const removeApp = script.indexOf('  RMDir /r "$INSTDIR\\app"', fallback);
    const removeRoot = script.indexOf('  RMDir "$INSTDIR"', removeApp);
    expect(fallback).toBeGreaterThan(uninstallSection);
    expect(removeApp).toBeGreaterThan(fallback);
    expect(removeRoot).toBeGreaterThan(removeApp);
  });

  test("supports spaces while escaping structured dollar and quote characters", () => {
    const script = renderNsisScript({
      ...base,
      appDir: "C:\\build $cache\\Safe App",
      out: "C:\\release $cache\\setup.exe",
      options: { publisher: 'Example "$INSTDIR"' },
    });

    expect(script).toContain('File /r "C:\\build $$cache\\Safe App\\*"');
    expect(script).toContain('OutFile "C:\\release $$cache\\setup.exe"');
    expect(script).not.toContain('"Publisher" "Example "$INSTDIR""');
    expect(script).toContain("Example");
  });

  test("rejects newline and install-directory injection fixtures", () => {
    expect(() => renderNsisScript({ ...base, options: { publisher: "Example\nSection" } })).toThrow(
      "control characters",
    );
    expect(() =>
      renderNsisScript({
        ...base,
        options: { installDir: '$PROGRAMFILES64\\Safe App"\nSection' },
      }),
    ).toThrow("installDir");
    expect(() => renderNsisScript({ ...base, appName: 'Safe App"\nSection' })).toThrow(
      "invalid app name",
    );
  });
});
