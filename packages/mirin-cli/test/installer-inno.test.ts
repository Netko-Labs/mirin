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
    expect(script).toContain('DestDir: "{app}"');
  });

  test("rejects structured control characters and leaves include as the raw extension point", () => {
    expect(() => renderInnoScript({ ...base, options: { publisher: "Example\n[Files]" } })).toThrow(
      "control characters",
    );

    const include = "[Code]\nprocedure InitializeWizard; begin end;";
    expect(renderInnoScript({ ...base, options: { include } })).toContain(include);
  });
});
