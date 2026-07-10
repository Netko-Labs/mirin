import type { Manifest } from "../types.ts";
import { artifactUrl } from "./urls.ts";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;

export function parseManifest(
  value: unknown,
  expected: { channel: string; platform: string; arch: string },
): Manifest {
  const manifest = record(value, "manifest");
  const parsed: Manifest = {
    version: versionField(manifest, "version"),
    channel: stringField(manifest, "channel"),
    platform: stringField(manifest, "platform"),
    arch: stringField(manifest, "arch"),
    tarHash: sha256Field(manifest, "tarHash"),
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

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new Error(`invalid update manifest field: ${key}`);
  }
  return value;
}

function versionField(source: Record<string, unknown>, key: string): string {
  const value = stringField(source, key);
  if (
    value.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value,
    )
  ) {
    throw new Error(`invalid update manifest version: ${key}`);
  }
  return value;
}

function sha256Field(source: Record<string, unknown>, key: string): string {
  const value = stringField(source, key);
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`invalid update manifest hash: ${key}`);
  }
  return value.toLowerCase();
}

function sizeField(source: Record<string, unknown>): number | undefined {
  const value = source.size;
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_ARTIFACT_BYTES
  ) {
    throw new Error("invalid update manifest field: size");
  }
  return value;
}

function artifactField(value: unknown, label: string): Manifest["bundle"] {
  const source = record(value, label);
  const url = stringField(source, "url");
  artifactUrl("https://example.invalid", url);
  return {
    url,
    sha256: sha256Field(source, "sha256"),
    size: sizeField(source),
  };
}

function patchesField(value: unknown): Manifest["patches"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid update manifest field: patches");
  return value.map((item, index) => {
    const patch = record(item, `patches[${index}]`);
    const artifact = artifactField(patch, `patches[${index}]`);
    return {
      fromVersion: versionField(patch, "fromVersion"),
      ...artifact,
    };
  });
}
