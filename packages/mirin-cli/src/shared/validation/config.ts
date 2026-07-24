import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_APP_NAME_LENGTH = 120;
const MAX_CHANNEL_LENGTH = 64;
const MAX_IDENTIFIER_LENGTH = 233;
const MAX_VERSION_LENGTH = 128;
const MAX_RELEASE_NOTES_LENGTH = 64 * 1024;
export const DEFAULT_APP_VERSION = "1.0.0";

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const PORTABLE_APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/;
const FLAT_CHANNEL = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const IDENTIFIER_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const STRICT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface AppIdentityInput {
  appName: unknown;
  bundleId: unknown;
  channel: unknown;
  version: unknown;
}

export interface ValidatedAppIdentity {
  appName: string;
  bundleId: string;
  channel: string;
  version: string;
}

export function validateAppIdentity(input: AppIdentityInput): ValidatedAppIdentity {
  return {
    appName: validateAppName(input.appName),
    bundleId: validateBundleId(input.bundleId),
    channel: validateReleaseChannel(input.channel),
    version: validateAppVersion(input.version),
  };
}

/** Validate the app name before it is used as a portable bundle path segment. */
export function validateAppName(value: unknown): string {
  const name = requiredString(value, "app name");
  if (
    name.length > MAX_APP_NAME_LENGTH ||
    name !== name.trim() ||
    name.endsWith(".") ||
    name === "." ||
    name === ".." ||
    !PORTABLE_APP_NAME.test(name) ||
    WINDOWS_RESERVED_NAME.test(name)
  ) {
    throw new Error(
      `[mirin] invalid app name ${quoted(name)} — use 1–${MAX_APP_NAME_LENGTH} ASCII letters, ` +
        'digits, spaces, ".", "_", "(", ")" or "-" in one portable path segment; ' +
        "do not use a Windows reserved name or leading/trailing whitespace/dots.",
    );
  }
  return name;
}

/** Validate a reverse-DNS identifier used in bundle metadata and support paths. */
export function validateBundleId(value: unknown): string {
  const identifier = requiredString(value, "app id");
  const labels = identifier.split(".");
  if (
    identifier.length > MAX_IDENTIFIER_LENGTH ||
    labels.length < 2 ||
    labels.some((label) => label.length > 63 || !IDENTIFIER_LABEL.test(label)) ||
    WINDOWS_RESERVED_NAME.test(identifier)
  ) {
    throw new Error(
      `[mirin] invalid app id ${quoted(identifier)} — use a reverse-DNS identifier such as ` +
        `"dev.example.my-app" with at least two 1–63 character ASCII labels and up to ` +
        `${MAX_IDENTIFIER_LENGTH} total characters.`,
    );
  }
  return identifier;
}

/** Validate the release channel before it becomes a path and artifact-name segment. */
export function validateReleaseChannel(value: unknown): string {
  const channel = requiredString(value, "release channel");
  if (
    channel.length > MAX_CHANNEL_LENGTH ||
    channel === "." ||
    channel === ".." ||
    !FLAT_CHANNEL.test(channel) ||
    channel.endsWith(".") ||
    WINDOWS_RESERVED_NAME.test(channel)
  ) {
    throw new Error(
      `[mirin] invalid release channel ${quoted(channel)} — use 1–${MAX_CHANNEL_LENGTH} letters, ` +
        'digits, ".", "_" or "-" in one non-reserved path segment, with separators between names.',
    );
  }
  return channel;
}

/** Validate an exact SemVer 2.0.0 string. */
export function validateAppVersion(value: unknown): string {
  const version = requiredString(value, "app version");
  if (version.length > MAX_VERSION_LENGTH || !STRICT_SEMVER.test(version)) {
    throw new Error(
      `[mirin] invalid app version ${quoted(version)} — expected strict SemVer such as ` +
        '"1.2.3" or "1.2.3-beta.1".',
    );
  }
  return version;
}

/** Validate optional markdown release notes against the runtime manifest contract. */
export function validateReleaseNotes(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_RELEASE_NOTES_LENGTH) {
    throw new Error(
      `[mirin] invalid release notes — expected a string of at most ${MAX_RELEASE_NOTES_LENGTH} characters.`,
    );
  }
  return value;
}

/** Resolve and validate the version override/environment/package.json precedence. */
export function resolveAppVersion(projectDir: string, explicit?: unknown): string {
  if (explicit != null) return validateAppVersion(explicit);
  if (process.env.MIRIN_APP_VERSION) {
    return validateAppVersion(process.env.MIRIN_APP_VERSION);
  }

  const packagePath = join(projectDir, "package.json");
  if (!existsSync(packagePath)) return DEFAULT_APP_VERSION;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    throw new Error(`[mirin] invalid package.json at ${packagePath}.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[mirin] invalid package.json at ${packagePath}.`);
  }
  const version = (parsed as Record<string, unknown>).version ?? DEFAULT_APP_VERSION;
  return validateAppVersion(version);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[mirin] invalid ${label} ${quoted(value)} — expected a non-empty string.`);
  }
  return value;
}

function quoted(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
