const MAX_SEMVER_LENGTH = 128;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const NUMERIC = /^\d+$/;

/** Validate the exact SemVer grammar accepted by the packaged updater runtime. */
export function validateReleaseVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SEMVER_LENGTH) {
    throw new Error("app version must be strict SemVer");
  }

  const plus = value.indexOf("+");
  if (plus !== -1 && value.indexOf("+", plus + 1) !== -1) {
    throw new Error("app version must be strict SemVer");
  }
  const withoutBuild = plus === -1 ? value : value.slice(0, plus);
  if (plus !== -1) validateIdentifiers(value.slice(plus + 1), false);

  const hyphen = withoutBuild.indexOf("-");
  const core = hyphen === -1 ? withoutBuild : withoutBuild.slice(0, hyphen);
  if (hyphen !== -1) validateIdentifiers(withoutBuild.slice(hyphen + 1), true);
  const parts = core.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !NUMERIC.test(part) || (part.length > 1 && part.startsWith("0")))
  ) {
    throw new Error("app version must be strict SemVer");
  }
  return value;
}

function validateIdentifiers(value: string, rejectNumericLeadingZero: boolean): void {
  const identifiers = value.split(".");
  if (
    value.length === 0 ||
    identifiers.some(
      (identifier) =>
        !IDENTIFIER.test(identifier) ||
        (rejectNumericLeadingZero &&
          NUMERIC.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith("0")),
    )
  ) {
    throw new Error("app version must be strict SemVer");
  }
}
