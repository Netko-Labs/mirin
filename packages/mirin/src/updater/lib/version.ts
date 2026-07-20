import type { VersionInfo } from "../types.ts";
import { MAX_VERSION_JSON_BYTES } from "./limits.ts";
import { parseSemVer } from "./semver.ts";
import { trustedBaseUrl } from "./urls.ts";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid installed version metadata");
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string, maxLength: number): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`invalid installed version field: ${key}`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function appNameField(source: Record<string, unknown>): string {
  const value = stringField(source, "name", 128);
  if (
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    throw new Error("invalid installed version field: name");
  }
  return value;
}

function channelField(source: Record<string, unknown>): string {
  const value = stringField(source, "channel", 64);
  if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(value)) {
    throw new Error("invalid installed version field: channel");
  }
  return value;
}

function identifierField(source: Record<string, unknown>): string {
  const value = stringField(source, "identifier", 255);
  const parts = value.split(".");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part.length > 63 ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part),
    )
  ) {
    throw new Error("invalid installed version field: identifier");
  }
  return value;
}

export function parseVersionInfo(value: unknown): VersionInfo {
  const source = record(value);
  const version = stringField(source, "version", 128);
  parseSemVer(version);
  const baseUrl = trustedBaseUrl(stringField(source, "baseUrl", 2048));
  return {
    version,
    channel: channelField(source),
    baseUrl,
    name: appNameField(source),
    identifier: identifierField(source),
  };
}

export function parseVersionJson(text: string): VersionInfo {
  if (new TextEncoder().encode(text).byteLength > MAX_VERSION_JSON_BYTES) {
    throw new Error("installed version metadata is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid installed version metadata JSON");
  }
  return parseVersionInfo(value);
}
