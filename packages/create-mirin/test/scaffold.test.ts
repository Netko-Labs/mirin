import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, scaffoldBasename, validateScaffoldName } from "../src/scaffold.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("scaffold names", () => {
  test("extracts POSIX and synthetic Windows basenames on every platform", () => {
    expect(scaffoldBasename("/Users/test/my-app/")).toBe("my-app");
    expect(scaffoldBasename("C:\\Users\\test\\windows-app\\")).toBe("windows-app");
    expect(scaffoldBasename("\\\\server\\share\\network-app")).toBe("network-app");
  });

  test.each(["My-App", "my app", "my_app", "-my-app", "my-app-", "my--app", "../app"])(
    "rejects non-lowercase-kebab name %s",
    (name) => expect(() => validateScaffoldName(name)).toThrow("invalid app name"),
  );

  test("rejects invalid names before creating a partial target", () => {
    const root = temporaryDirectory();
    const target = join(root, "Invalid App");

    expect(() => scaffold(target)).toThrow("invalid app name");
    expect(existsSync(target)).toBe(false);
  });
});

describe("scaffold output", () => {
  test("writes valid JSON and substitutes the validated app identity", () => {
    const root = temporaryDirectory();
    const target = join(root, "valid-app");

    expect(scaffold(target)).toBe("valid-app");
    const packageJson: unknown = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "valid-app",
      private: true,
      dependencies: { mirinjs: expect.stringMatching(/^\^\d+\.\d+\.\d+/) },
      devDependencies: { "@mirinjs/cli": expect.stringMatching(/^\^\d+\.\d+\.\d+/) },
    });
    const config = readFileSync(join(target, "mirin.config.ts"), "utf8");
    expect(config).toContain('id: "dev.local.validapp"');
    expect(config).toContain('name: "valid-app"');
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, "_gitignore"))).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "create-mirin-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
