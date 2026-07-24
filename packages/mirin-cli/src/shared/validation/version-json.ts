import { type AppIdentityInput, type ValidatedAppIdentity, validateAppIdentity } from "./config.ts";

const MAX_VERSION_JSON_BYTES = 8 * 1024;
const MAX_BASE_URL_LENGTH = 2048;
const VERSION_FIELDS = ["version", "channel", "baseUrl", "name", "identifier"] as const;

export interface VersionMetadata {
  version: string;
  channel: string;
  baseUrl: string;
  name: string;
  identifier: string;
}

export interface VersionMetadataInput extends AppIdentityInput {
  baseUrl: unknown;
}

/** Serialize the five-field updater metadata envelope and verify its readback. */
export function serializeVersionMetadata(input: VersionMetadataInput): string {
  const identity = validateAppIdentity(input);
  const metadata: VersionMetadata = {
    version: identity.version,
    channel: identity.channel,
    baseUrl: validateReleaseBaseUrl(input.baseUrl),
    name: identity.appName,
    identifier: identity.bundleId,
  };
  const serialized = JSON.stringify(metadata);
  const readback = parseVersionMetadata(serialized);
  for (const field of VERSION_FIELDS) {
    if (readback[field] !== metadata[field]) {
      throw new Error(`[mirin] version.json readback mismatch: ${field}`);
    }
  }
  return serialized;
}

/** Parse and validate the CLI-owned version.json shape at bundle sinks. */
export function parseVersionMetadata(serialized: string): VersionMetadata {
  if (serialized.length === 0 || Buffer.byteLength(serialized) > MAX_VERSION_JSON_BYTES) {
    throw new Error("[mirin] invalid version.json — metadata is empty or too large.");
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("[mirin] invalid version.json — expected JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("[mirin] invalid version.json — expected an object.");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expectedKeys = [...VERSION_FIELDS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("[mirin] invalid version.json — expected exactly five identity fields.");
  }

  const identity = validateAppIdentity({
    appName: object.name,
    bundleId: object.identifier,
    channel: object.channel,
    version: object.version,
  });
  return {
    version: identity.version,
    channel: identity.channel,
    baseUrl: validateReleaseBaseUrl(object.baseUrl),
    name: identity.appName,
    identifier: identity.bundleId,
  };
}

/** Ensure serialized metadata agrees with the bundle identity that will contain it. */
export function validateVersionMetadataForBundle(
  serialized: string | undefined,
  identity: ValidatedAppIdentity,
): VersionMetadata | undefined {
  if (serialized == null) return undefined;
  const metadata = parseVersionMetadata(serialized);
  if (
    metadata.name !== identity.appName ||
    metadata.identifier !== identity.bundleId ||
    metadata.channel !== identity.channel ||
    metadata.version !== identity.version
  ) {
    throw new Error("[mirin] version.json identity does not match the bundle identity.");
  }
  return metadata;
}

/** Validate an embedded updater base URL without importing runtime updater internals. */
export function validateReleaseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) {
    throw new Error("[mirin] invalid release baseUrl — expected a bounded URL string.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[mirin] invalid release baseUrl: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error("[mirin] release baseUrl must not contain credentials.");
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return value;
  throw new Error(
    "[mirin] release baseUrl must use HTTPS, except loopback HTTP for local testing.",
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
