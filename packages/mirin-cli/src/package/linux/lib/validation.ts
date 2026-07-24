import { assertProjectIcon } from "../../../shared/fs/project-source.ts";
import type { LinuxPackageFormat, LinuxPackageInput } from "../types.ts";
import { LINUX_FORMATS } from "./defaults.ts";

/** A Debian/RPM-friendly package name: lowercase, alnum + `.-+`, no leading sigil. */
function shortName(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9.\-+]/g, "-")
      .replace(/^[.\-+]+/, "") || "app"
  );
}

export function safeLinuxPackageInput(input: LinuxPackageInput): LinuxPackageInput {
  return {
    ...input,
    appName: safeAppBinaryName(input.appName),
    bundleId: safeLinuxIdentifier(input.bundleId),
    version: safePackageVersion(input.version),
    icon: input.icon ? assertProjectIcon(input.projectDir, input.icon, "app icon") : undefined,
  };
}

function safeLinuxIdentifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(
      `[mirin] invalid Linux app id "${value}" — use a reverse-DNS style id with letters, ` +
        'digits, ".", "_" or "-".',
    );
  }
  return value;
}

function safeAppBinaryName(value: string): string {
  if (value.length === 0 || value === "." || value === ".." || /[\0\r\n/"\\`$]/.test(value)) {
    throw new Error(
      `[mirin] invalid Linux app name "${value}" — it becomes a binary path segment, ` +
        "so it cannot contain path separators, quotes, shell expansion characters, or newlines.",
    );
  }
  return value;
}

function safePackageVersion(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/.test(value)) {
    throw new Error(
      `[mirin] invalid Linux package version "${value}" — use only letters, digits, ".", "+", ":", "~", "_" or "-".`,
    );
  }
  return value;
}

export function safePackageName(value: string): string {
  return shortName(value);
}

export function validateLinuxFormats(
  formats: readonly string[],
  source: string,
): LinuxPackageFormat[] {
  const allowed = new Set<string>(LINUX_FORMATS);
  const out: LinuxPackageFormat[] = [];
  for (const format of formats) {
    if (!allowed.has(format)) {
      throw new Error(
        `[mirin] invalid Linux package format "${format}" in ${source}; expected appimage, deb, or rpm.`,
      );
    }
    if (!out.includes(format as LinuxPackageFormat)) out.push(format as LinuxPackageFormat);
  }
  return out;
}
