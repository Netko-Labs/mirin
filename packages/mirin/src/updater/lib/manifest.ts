import type { Manifest, UpdateArtifact, UpdatePatch } from "../types.ts";
import { MAX_ARTIFACT_BYTES, MAX_PATCH_BYTES, MAX_PATCH_COUNT, MAX_TAR_BYTES } from "./limits.ts";
import { parseSemVer } from "./semver.ts";
import { artifactUrl } from "./urls.ts";

export function parseManifest(
  value: unknown,
  expected: { channel: string; platform: string; arch: string },
): Manifest {
  const manifest = record(value, "manifest");
  const body = optionalStringField(manifest, "body", 64 * 1024);
  const parsed: Manifest = {
    version: versionField(manifest, "version"),
    channel: stringField(manifest, "channel", 64),
    platform: stringField(manifest, "platform", 32),
    arch: stringField(manifest, "arch", 32),
    ...(body === undefined ? {} : { body }),
    tarHash: sha256Field(manifest, "tarHash"),
    tarSize: sizeField(manifest, "tarSize", MAX_TAR_BYTES),
    bundle: artifactField(manifest.bundle, "bundle"),
    patches: patchesField(manifest.patches),
  };
  if (
    parsed.channel !== expected.channel ||
    parsed.platform !== expected.platform ||
    parsed.arch !== expected.arch
  ) {
    throw new Error(
      `manifest target mismatch: expected ${expected.channel}/${expected.platform}/${expected.arch}`,
    );
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid update ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string, maxLength = 1024): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`invalid update manifest field: ${key}`);
  }
  return value;
}

function optionalStringField(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`invalid update manifest field: ${key}`);
  }
  return value;
}

function versionField(source: Record<string, unknown>, key: string): string {
  const value = stringField(source, key, 128);
  try {
    parseSemVer(value);
  } catch {
    throw new Error(`invalid update manifest version: ${key}`);
  }
  return value;
}

function sha256Field(source: Record<string, unknown>, key: string): string {
  const value = stringField(source, key, 64);
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`invalid update manifest hash: ${key}`);
  }
  return value.toLowerCase();
}

function sizeField(source: Record<string, unknown>, key: string, maximum: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`invalid update manifest field: ${key}`);
  }
  return value;
}

function artifactField(value: unknown, label: string): UpdateArtifact {
  const source = record(value, label);
  const url = stringField(source, "url", 255);
  artifactUrl("https://example.invalid", url);
  return {
    url,
    sha256: sha256Field(source, "sha256"),
    size: sizeField(source, "size", MAX_ARTIFACT_BYTES),
  };
}

function patchesField(value: unknown): UpdatePatch[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PATCH_COUNT) {
    throw new Error("invalid update manifest field: patches");
  }
  const versions = new Set<string>();
  return value.map((item, index) => {
    const patch = record(item, `patches[${index}]`);
    const fromVersion = versionField(patch, "fromVersion");
    if (versions.has(fromVersion)) throw new Error(`duplicate update patch: ${fromVersion}`);
    versions.add(fromVersion);
    return {
      fromVersion,
      ...artifactField(patch, `patches[${index}]`),
      uncompressedSize: sizeField(patch, "uncompressedSize", MAX_PATCH_BYTES),
    };
  });
}
