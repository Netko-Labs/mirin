import { describe, expect, test } from "bun:test";
import { type RenderInnoInput, renderInnoScript } from "../src/installer-inno.ts";

const base: RenderInnoInput = {
  appDir: "C:\\build path\\Safe App",
  appName: "Safe App",
  exeName: "Safe App.exe",
  version: "1.2.3",
  channel: "stable",
  bundleId: "dev.example.safe-app",
  outDir: "C:\\release path",
  fileName: "stable-win32-x64-SafeApp-setup.exe",
  options: {},
  projectDir: "C:\\project path",
};

describe("Inno Setup script rendering", () => {
  test.each([
    ["{autopf}\\Safe App", "DefaultDirName={autopf}\\Safe App"],
    ["{localappdata}\\Programs\\Safe App", "DefaultDirName={localappdata}\\Programs\\Safe App"],
    ["C:\\Apps\\Safe App", "DefaultDirName=C:\\Apps\\Safe App"],
    ["\\\\server\\share\\Safe App", "DefaultDirName=\\\\server\\share\\Safe App"],
  ])("accepts install directory %s", (installDir, expected) => {
    expect(renderInnoScript({ ...base, options: { installDir } })).toContain(expected);
  });

  test.each([
    "relative\\Safe App",
    "$PROGRAMFILES64\\Safe App",
    "{code:InstallRoot}\\Safe App",
    "{unknown}\\Safe App",
    "\\root-relative",
    'C:\\Apps\\Safe"App',
    "C:\\Apps\\Safe App\n[Files]",
  ])("rejects unsafe install directory %s", (installDir) => {
    expect(() => renderInnoScript({ ...base, options: { installDir } })).toThrow("installDir");
  });

  test("escapes literal braces in filesystem paths while preserving generated constants", () => {
    const script = renderInnoScript({
      ...base,
      appDir: "C:\\build {cache}\\Safe App",
      outDir: "C:\\release {cache}",
      icon: "C:\\project {cache}\\icon.ico",
      license: "C:\\project {cache}\\license.txt",
    });

    expect(script).toContain("OutputDir=C:\\release {{cache}");
    expect(script).toContain("SetupIconFile=C:\\project {{cache}\\icon.ico");
    expect(script).toContain("LicenseFile=C:\\project {{cache}\\license.txt");
    expect(script).toContain('Source: "C:\\build {{cache}\\Safe App\\*"');
    expect(script).toContain('DestDir: "{app}\\app"');
  });

  test("replaces an owned nested payload and points every launcher at it", () => {
    const script = renderInnoScript({
      ...base,
      legacyRootFiles: ["Safe App.exe", "mirin_core.dll", "removed-runtime.bin"],
    });

    expect(script).toContain(
      'Type: filesandordirs; Name: "{app}\\app"; Check: IsOwnedNestedInstall',
    );
    expect(script).toContain("UninstallDisplayIcon={app}\\app\\Safe App.exe");
    expect(script).toContain('Filename: "{app}\\app\\Safe App.exe"');
    expect(script).not.toContain('Filename: "{app}\\Safe App.exe"');
    expect(script).toContain(
      'Type: files; Name: "{app}\\removed-runtime.bin"; Check: IsLegacyMirinFlatInstall',
    );
    expect(script).toContain("FileExists(ExpandConstant('{app}\\Safe App.exe')) and");
    expect(script).toContain(
      "FileExists(ExpandConstant('{app}\\resources\\mirin.manifest.json'));",
    );
    expect(script).not.toContain('Name: "{app}\\*"');
  });

  test("refuses unowned nested collisions and removes stale NSIS ownership", () => {
    const script = renderInnoScript(base);

    expect(script).toContain(
      "if DirExists(ExpandConstant('{app}\\app')) and not IsOwnedNestedInstall then",
    );
    expect(script).toContain(
      "FileExists(ExpandConstant('{app}\\.mirin-dev.example.safe-app.owned'))",
    );
    expect(script).toContain(
      'Type: files; Name: "{app}\\Uninstall.exe"; Check: IsPriorMirinInstall',
    );
    expect(script).toContain(
      "RegDeleteKeyIncludingSubkeys(HKCU32, 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dev.example.safe-app');",
    );
    expect(script).toContain(
      "SaveStringToFile(ExpandConstant('{app}\\.mirin-dev.example.safe-app.owned')",
    );
  });

  test("recursively removes only the marker-owned updater payload on uninstall", () => {
    const script = renderInnoScript(base);
    const uninstall = script.indexOf("[UninstallDelete]");

    expect(uninstall).toBeGreaterThan(-1);
    expect(
      script.indexOf('Name: "{app}\\app"; Check: IsOwnedNestedInstall', uninstall),
    ).toBeGreaterThan(uninstall);
    expect(
      script.indexOf('Name: "{app}\\.mirin-dev.example.safe-app.owned"', uninstall),
    ).toBeGreaterThan(uninstall);
  });

  test("rejects unsafe names in enumerated legacy cleanup", () => {
    expect(() => renderInnoScript({ ...base, legacyRootFiles: ["../outside"] })).toThrow(
      "unsafe legacy payload file name",
    );
    expect(() => renderInnoScript({ ...base, legacyRootFiles: ["unins000.exe"] })).toThrow(
      "unsafe legacy payload file name",
    );
  });

  test("rejects structured control characters and leaves include as the raw extension point", () => {
    expect(() => renderInnoScript({ ...base, options: { publisher: "Example\n[Files]" } })).toThrow(
      "control characters",
    );

    const include = "[Code]\nprocedure InitializeWizard; begin end;";
    expect(renderInnoScript({ ...base, options: { include } })).toContain(include);
  });
});
