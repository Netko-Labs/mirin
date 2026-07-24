import { validateReleaseChannel as validateSharedReleaseChannel } from "../shared/validation/config.ts";

export function validateReleaseChannel(value: string): string {
  try {
    return validateSharedReleaseChannel(value);
  } catch {
    throw new Error("release.channel must be a safe channel name");
  }
}
