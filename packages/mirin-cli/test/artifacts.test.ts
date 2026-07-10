import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateArchiveEntries,
  validateExtractedSymlinks,
  verifyFileSha256,
} from "../src/artifacts.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CEF archive validation", () => {
  test("accepts the flat and framework archive layouts", () => {
    expect(() =>
      validateArchiveEntries(
        [
          "./",
          "./libcef.so",
          "./locales/en-US.pak",
          "Chromium Embedded Framework.framework/Versions/Current",
        ].join("\n"),
      ),
    ).not.toThrow();
  });

  test.each(["../escape", "nested/../../escape", "/absolute", "C:/absolute", "..\\escape"])(
    "rejects unsafe entry %s",
    (entry) => {
      expect(() => validateArchiveEntries(entry)).toThrow("unsafe CEF archive entry");
    },
  );

  test("accepts contained symlinks and rejects escaping symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-cef-test-"));
    temporaryDirectories.push(root);
    const nested = join(root, "framework", "Versions");
    mkdirSync(nested, { recursive: true });

    symlinkSync("../Resources", join(nested, "Contained"));
    expect(() => validateExtractedSymlinks(root)).not.toThrow();

    symlinkSync("../../../outside", join(nested, "Escaping"));
    expect(() => validateExtractedSymlinks(root)).toThrow("symlink escapes its cache");
  });

  test("verifies release asset checksums before extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-cef-test-"));
    temporaryDirectories.push(root);
    const archive = join(root, "archive.tar.gz");
    writeFileSync(archive, "mirin");

    await expect(
      verifyFileSha256(
        archive,
        "36413cff904407f785f9fc2cda350203596faf365847dca195e34b4fb2f91794\n",
      ),
    ).resolves.toBeUndefined();
    await expect(verifyFileSha256(archive, "not-a-checksum")).rejects.toThrow(
      "invalid CEF SHA-256 checksum",
    );
    await expect(verifyFileSha256(archive, "0".repeat(64))).rejects.toThrow("CEF SHA-256 mismatch");
  });
});
