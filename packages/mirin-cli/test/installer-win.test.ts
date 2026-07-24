import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const compileTest = Bun.which("makensis") ? test : test.skip;

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
    expect(script).toContain("  Call RequireOwnedNestedOrEmpty");
    expect(script).toContain('IfFileExists "$INSTDIR\\app\\*" 0 require_owned_done');
    expect(script).toContain(
      'IfFileExists "$INSTDIR\\.mirin-dev.example.safe-app.owned" require_owned_done 0',
    );
    expect(script).toContain('FileOpen $0 "$INSTDIR\\.mirin-dev.example.safe-app.owned" w');
  });

  test("uninstalls only owned entries and removes the root non-recursively", () => {
    const lines = renderNsisScript(base).split("\n");

    expect(lines).toContain('  RMDir /r "$INSTDIR\\app"');
    expect(lines).toContain(
      '  IfFileExists "$INSTDIR\\.mirin-dev.example.safe-app.owned" 0 .payloadDone',
    );
    expect(lines).toContain('  Delete "$INSTDIR\\Uninstall.exe"');
    expect(lines).toContain('  RMDir "$INSTDIR"');
    expect(lines).not.toContain('  RMDir /r "$INSTDIR"');
    expect(lines.some((line) => line.includes("DeleteRegKey HKCU"))).toBe(true);
  });

  test("removes a prior Inno uninstaller only after matching the ownership marker", () => {
    const script = renderNsisScript(base);
    const cleanup = script.indexOf("Function CleanupOwnedNestedInstall");

    expect(cleanup).toBeGreaterThan(-1);
    expect(
      script.indexOf(
        'IfFileExists "$INSTDIR\\.mirin-dev.example.safe-app.owned" 0 cleanup_owned_done',
        cleanup,
      ),
    ).toBeGreaterThan(cleanup);
    expect(script.indexOf('Delete "$INSTDIR\\unins000.exe"', cleanup)).toBeGreaterThan(cleanup);
    expect(
      script.indexOf(
        'DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{dev.example.safe-app}_is1"',
        cleanup,
      ),
    ).toBeGreaterThan(cleanup);
  });

  test("guards exact legacy flat cleanup and provides an uninstall fallback", () => {
    const script = renderNsisScript({
      ...base,
      legacyRootFiles: ["removed-runtime.dll"],
    });

    expect(script).toContain("Function CleanupLegacyFlatPayload");
    expect(script).toContain("Function un.CleanupLegacyFlatPayload");
    expect(script).toContain(
      'IfFileExists "$INSTDIR\\Safe App.exe" 0 CleanupLegacyFlatPayload_done',
    );
    expect(script).toContain(
      'IfFileExists "$INSTDIR\\mirin_core.dll" 0 CleanupLegacyFlatPayload_done',
    );
    expect(script).toContain(
      'IfFileExists "$INSTDIR\\mirin-helper.exe" 0 CleanupLegacyFlatPayload_done',
    );
    expect(script).toContain('IfFileExists "$INSTDIR\\libcef.dll" 0 CleanupLegacyFlatPayload_done');
    expect(script).toContain(
      'IfFileExists "$INSTDIR\\resources\\mirin.manifest.json" 0 CleanupLegacyFlatPayload_done',
    );
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

  compileTest("compiles the ownership and cross-installer lifecycle script", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-nsis-compile-"));
    try {
      const payload = join(root, "payload");
      mkdirSync(payload);
      writeFileSync(join(payload, "Safe App.exe"), "app");
      const script = join(root, "installer.nsi");
      writeFileSync(
        script,
        renderNsisScript({
          ...base,
          appDir: payload,
          outDir: root,
          out: join(root, "setup.exe"),
          projectDir: root,
        }),
      );

      const result = Bun.spawnSync(["makensis", "-V2", script]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
