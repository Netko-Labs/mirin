import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderNsisScript } from "../src/installer-win.ts";

const canRun = process.platform === "win32" && Bun.which("makensis") != null;
const integrationTest = canRun ? test : test.skip;
const temporaryDirectories: string[] = [];

const APP_NAME = "Safe App";
const EXE_NAME = `${APP_NAME}.exe`;

beforeCleanup();

describe("NSIS install lifecycle", () => {
  integrationTest(
    "migrates flat payload to new layout and uninstalls without deleting sentinel",
    () => {
      const root = temporaryDirectory();
      const installDir = join(root, "install");
      const legacyPayload = join(root, "legacy-payload");
      createPayload(legacyPayload, ["snapshot_blob.bin", "unins000.dat"]);
      const legacyInstaller = compileLegacyFlatInstaller(root, legacyPayload, installDir);
      runInstaller(legacyInstaller, installDir);
      const sentinel = join(installDir, "sentinel.txt");
      writeFileSync(sentinel, "keep");

      const newPayload = join(root, "new-payload");
      createPayload(newPayload);
      const newInstaller = compileNewInstaller(root, newPayload, installDir, "new-setup.exe");
      runInstaller(newInstaller, installDir);

      expect(existsSync(join(installDir, EXE_NAME))).toBe(false);
      expect(existsSync(join(installDir, "mirin_core.dll"))).toBe(false);
      expect(existsSync(join(installDir, "snapshot_blob.bin"))).toBe(false);
      expect(existsSync(join(installDir, "unins000.dat"))).toBe(false);
      expect(existsSync(join(installDir, "app", EXE_NAME))).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");

      runExecutable(join(installDir, "Uninstall.exe"), ["/S"]);
      expect(existsSync(join(installDir, "app"))).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
    },
  );

  integrationTest(
    "removes files dropped between new-layout versions and preserves sentinel",
    () => {
      const root = temporaryDirectory();
      const installDir = join(root, "install");
      const v1Payload = join(root, "v1-payload");
      createPayload(v1Payload, ["removed-in-v2.txt"]);
      runInstaller(compileNewInstaller(root, v1Payload, installDir, "v1-setup.exe"), installDir);
      const sentinel = join(installDir, "sentinel.txt");
      writeFileSync(sentinel, "keep");
      expect(existsSync(join(installDir, "app", "removed-in-v2.txt"))).toBe(true);

      const v2Payload = join(root, "v2-payload");
      createPayload(v2Payload);
      runInstaller(compileNewInstaller(root, v2Payload, installDir, "v2-setup.exe"), installDir);

      expect(existsSync(join(installDir, "app", "removed-in-v2.txt"))).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
      runExecutable(join(installDir, "Uninstall.exe"), ["/S"]);
      expect(existsSync(join(installDir, "app"))).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
    },
  );
});

function beforeCleanup(): void {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mirin-nsis-integration-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createPayload(directory: string, extraFiles: readonly string[] = []): void {
  mkdirSync(join(directory, "resources"), { recursive: true });
  mkdirSync(join(directory, "locales"), { recursive: true });
  for (const file of [
    EXE_NAME,
    "mirin_core.dll",
    "mirin-helper.exe",
    "libcef.dll",
    ...extraFiles,
  ]) {
    writeFileSync(join(directory, file), file);
  }
  writeFileSync(join(directory, "resources", "mirin.manifest.json"), "{}");
  writeFileSync(join(directory, "locales", "en-US.pak"), "locale");
}

function compileLegacyFlatInstaller(root: string, payload: string, installDir: string): string {
  const out = join(root, "legacy-setup.exe");
  const script = join(root, "legacy.nsi");
  writeFileSync(
    script,
    [
      "Unicode True",
      `OutFile "${nsisLiteral(out)}"`,
      `InstallDir "${nsisLiteral(installDir)}"`,
      "RequestExecutionLevel user",
      "Section",
      '  SetOutPath "$INSTDIR"',
      `  File /r "${nsisLiteral(payload)}\\*"`,
      '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
      "SectionEnd",
      'Section "Uninstall"',
      '  RMDir /r "$INSTDIR"',
      "SectionEnd",
      "",
    ].join("\n"),
  );
  compileNsis(script);
  return out;
}

function compileNewInstaller(
  root: string,
  payload: string,
  installDir: string,
  fileName: string,
): string {
  const out = join(root, fileName);
  const script = join(root, `${fileName}.nsi`);
  const legacyRootFiles = readdirSync(payload, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  writeFileSync(
    script,
    renderNsisScript({
      appDir: payload,
      appName: APP_NAME,
      exeName: EXE_NAME,
      version: "1.2.3",
      channel: "stable",
      bundleId: "dev.example.safe-app",
      outDir: root,
      out,
      fileName,
      options: {
        installDir,
        oneClick: true,
        desktopShortcut: false,
        startMenuShortcut: false,
        runAfterFinish: false,
      },
      projectDir: root,
      legacyRootFiles,
    }),
  );
  compileNsis(script);
  return out;
}

function compileNsis(script: string): void {
  const result = Bun.spawnSync({ cmd: ["makensis", "-V2", script] });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function runInstaller(installer: string, installDir: string): void {
  runExecutable(installer, ["/S", `/D=${installDir}`]);
}

function runExecutable(executable: string, args: readonly string[]): void {
  const result = Bun.spawnSync({ cmd: [executable, ...args] });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function nsisLiteral(value: string): string {
  return value.replace(/\$/g, "$$$$").replace(/"/g, '$\\"');
}
