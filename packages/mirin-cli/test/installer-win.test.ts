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
  test("keeps the owned payload under $INSTDIR\\app and quotes executable commands", () => {
    const script = renderNsisScript(base);

    expect(script).toContain('SetOutPath "$INSTDIR\\app"');
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
