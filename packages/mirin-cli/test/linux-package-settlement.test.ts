import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LinuxPackageCleanupError,
  runWithLinuxStagingCleanup,
  settleLinuxPackageBuilds,
  stripUpdaterMetadataForManagedPackage,
} from "../src/package/linux/package.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parallel Linux package settlement", () => {
  test("waits for sibling jobs and removes successful artifacts before propagating failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-linux-package-settlement-"));
    temporaryDirectories.push(root);
    const artifact = join(root, "late.deb");
    const failedArtifact = join(root, "partial.rpm");
    writeFileSync(failedArtifact, "partial package");
    let finishSibling: (() => void) | undefined;
    let siblingSettled = false;
    const sibling = new Promise<{
      format: "deb";
      path: string;
      size: number;
    }>((resolve) => {
      finishSibling = () => {
        writeFileSync(artifact, "package");
        siblingSettled = true;
        resolve({ format: "deb", path: artifact, size: 7 });
      };
    });

    const operation = settleLinuxPackageBuilds(
      [Promise.reject(new Error("rpm failed")), sibling],
      [failedArtifact, artifact],
    );
    await Promise.resolve();
    expect(siblingSettled).toBe(false);
    finishSibling?.();

    await expect(operation).rejects.toThrow("rpm failed");
    expect(siblingSettled).toBe(true);
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(failedArtifact)).toBe(false);
  });

  test("makes staging cleanup failure fatal after otherwise successful packaging", async () => {
    await expect(
      runWithLinuxStagingCleanup(
        "/synthetic/package-stage",
        () => "built",
        () => {
          throw new Error("cleanup denied");
        },
      ),
    ).rejects.toBeInstanceOf(LinuxPackageCleanupError);
  });

  test("removes standalone updater metadata from package-managed payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-linux-managed-package-"));
    temporaryDirectories.push(root);
    const resources = join(root, "resources");
    mkdirSync(resources);
    const version = join(resources, "version.json");
    writeFileSync(version, "{}");

    stripUpdaterMetadataForManagedPackage(root);

    expect(existsSync(version)).toBe(false);
  });
});
