const SAFE_RELEASE_CHANNEL = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function validateReleaseChannel(value: string): string {
  if (
    value.length === 0 ||
    value.length > 64 ||
    !SAFE_RELEASE_CHANNEL.test(value) ||
    WINDOWS_RESERVED_NAME.test(value)
  ) {
    throw new Error("release.channel must be a safe channel name");
  }
  return value;
}
