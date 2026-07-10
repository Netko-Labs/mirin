const PRERELEASE_TAGS = new Set(["alpha", "beta", "rc", "canary", "dev", "next"]);

/** Resolve the registry dist-tag without ever promoting a prerelease to `latest`. */
export function distTagForVersion(version: string): string {
  const match =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) throw new Error(`invalid package version: ${version}`);

  const channel = match[1]?.toLowerCase();
  if (!channel) return "latest";
  return PRERELEASE_TAGS.has(channel) ? channel : "next";
}
