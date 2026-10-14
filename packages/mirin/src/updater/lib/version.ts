// Loose semver: "1.2.3", "v1.2.3", "1.2.3-nightly.4". Numeric segments compare
// as numbers, anything else lexically; a prerelease sorts below its release.
function parse(version: string): { main: string[]; pre: string[] } {
  const trimmed = version.trim().replace(/^v/i, "");
  const plus = trimmed.indexOf("+");
  const noBuild = plus === -1 ? trimmed : trimmed.slice(0, plus);
  const dash = noBuild.indexOf("-");
  const main = (dash === -1 ? noBuild : noBuild.slice(0, dash)).split(".");
  const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split(".");
  return { main, pre };
}

function compareSegment(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const na = /^\d+$/.test(a) ? Number(a) : null;
  const nb = /^\d+$/.test(b) ? Number(b) : null;
  if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.main.length, pb.main.length); i++) {
    const c = compareSegment(pa.main[i] ?? "0", pb.main[i] ?? "0");
    if (c !== 0) return c;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const c = compareSegment(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
