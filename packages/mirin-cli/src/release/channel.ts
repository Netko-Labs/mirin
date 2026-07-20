const SAFE_RELEASE_CHANNEL = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

export function validateReleaseChannel(value: string): string {
  if (value.length === 0 || value.length > 64 || !SAFE_RELEASE_CHANNEL.test(value)) {
    throw new Error("release.channel must be a safe channel name");
  }
  return value;
}
