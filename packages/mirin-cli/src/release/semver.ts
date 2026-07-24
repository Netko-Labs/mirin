import { validateAppVersion } from "../shared/validation/config.ts";

/** Validate the exact SemVer grammar accepted by the packaged updater runtime. */
export function validateReleaseVersion(value: unknown): string {
  try {
    return validateAppVersion(value);
  } catch {
    throw new Error("app version must be strict SemVer");
  }
}
