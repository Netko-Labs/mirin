const MAX_SEMVER_LENGTH = 128;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const NUMERIC = /^\d+$/;

export interface SemVer {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

function numericIdentifier(value: string, label: string): string {
  if (!NUMERIC.test(value) || (value.length > 1 && value.startsWith("0"))) {
    throw new Error(`invalid SemVer ${label}`);
  }
  return value;
}

function identifiers(value: string, label: string, rejectNumericLeadingZero: boolean): string[] {
  if (value.length === 0) throw new Error(`invalid SemVer ${label}`);
  return value.split(".").map((identifier) => {
    if (!IDENTIFIER.test(identifier)) throw new Error(`invalid SemVer ${label}`);
    if (
      rejectNumericLeadingZero &&
      NUMERIC.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith("0")
    ) {
      throw new Error(`invalid SemVer ${label}`);
    }
    return identifier;
  });
}

export function parseSemVer(value: string): SemVer {
  if (value.length === 0 || value.length > MAX_SEMVER_LENGTH) {
    throw new Error("invalid SemVer");
  }

  const plus = value.indexOf("+");
  if (plus !== -1 && value.indexOf("+", plus + 1) !== -1) throw new Error("invalid SemVer");
  const withoutBuild = plus === -1 ? value : value.slice(0, plus);
  if (plus !== -1) identifiers(value.slice(plus + 1), "build metadata", false);

  const hyphen = withoutBuild.indexOf("-");
  const core = hyphen === -1 ? withoutBuild : withoutBuild.slice(0, hyphen);
  const prerelease =
    hyphen === -1 ? [] : identifiers(withoutBuild.slice(hyphen + 1), "prerelease", true);
  const parts = core.split(".");
  if (parts.length !== 3) throw new Error("invalid SemVer core");

  return {
    major: numericIdentifier(parts[0] ?? "", "major"),
    minor: numericIdentifier(parts[1] ?? "", "minor"),
    patch: numericIdentifier(parts[2] ?? "", "patch"),
    prerelease,
  };
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  for (const key of ["major", "minor", "patch"] as const) {
    const comparison = compareNumeric(a[key], b[key]);
    if (comparison !== 0) return comparison;
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;
    if (aIdentifier === bIdentifier) continue;
    const aNumeric = NUMERIC.test(aIdentifier);
    const bNumeric = NUMERIC.test(bIdentifier);
    if (aNumeric && bNumeric) return compareNumeric(aIdentifier, bIdentifier);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aIdentifier < bIdentifier ? -1 : 1;
  }
  return 0;
}

export function isStrictlyNewer(candidate: string, installed: string): boolean {
  return compareSemVer(candidate, installed) > 0;
}
