/**
 * The bundle `mirin-metal run` starts an app from (`cli.ts`). An app started
 * from its sources resolves, reads and evaluates every module it imports at
 * each start; one file built from them (`Bun.build`, React's production
 * build defined in, unused exports left out) starts in about half the time.
 * The bundle is kept in the user's cache, keyed on the entry, and used only
 * while every file it was built from is as it was then (size and
 * modification time, and the configuration files above the entry): a start
 * after an edit runs the sources, as before, and builds the bundle again in
 * the background for the next one, so the developer loop is never slower.
 *
 * What a bundle cannot keep, it is not used for:
 * - `import.meta.url`, `dir`, `path`, `dirname`, `filename` and `main`,
 *   and `__dirname` and `__filename`, are each module's own, written into
 *   the bundle as they would have been; a module where that cannot be done
 *   exactly (a string that spells one, a local of that name: the transpiled
 *   code then differs) leaves the app unbundled;
 * - a path resolved at run time (an `import()` or `require()` of a path
 *   made then, `require.resolve`, `import.meta.resolve`, `new Worker`) would
 *   resolve from the bundle's directory: an app with one is unbundled.
 * The verdict is kept as well, so an app that can't be bundled is looked at
 * once per change, not per start.
 *
 * This module is what a start reads, before every app `mirin-metal run`
 * starts, so it loads nothing (Bun's own file calls, no `node:fs`, which
 * alone takes 2 ms to load); `bundle-build.ts` builds, in the builder.
 * Paths are absolute and POSIX: the bundle is not used on Windows.
 */

/** Bumped when what is built, or how it is checked, changes. */
export const FORMAT = 1;

/**
 * A file the bundle depends on: its path, size and modification time in ms
 * (as `Bun.file` has them; a file that doesn't exist has its own time).
 */
export type Input = [path: string, size: number, mtimeMs: number];

/** The directory a path is in. */
export function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/** `dir` and `name` as one path. */
export function join(dir: string, ...names: string[]): string {
  return [dir.endsWith("/") ? dir.slice(0, -1) : dir, ...names].join("/");
}

export interface Manifest {
  format: number;
  bun: string;
  entry: string;
  nodeEnv: string;
  /** Null: the app can't be run from a bundle (`reason`). */
  bundle: string | null;
  reason?: string;
  inputs: Input[];
}

/** Configuration that changes how a file is built (JSX, paths, defines). */
const CONFIGS = ["tsconfig.json", "jsconfig.json", "bunfig.toml", "package.json"];

/** The cache's directory for `entry` (an absolute path) built for `nodeEnv`. */
export function bundleDir(
  entry: string,
  nodeEnv: string,
  env: Record<string, string | undefined>,
): string {
  const root = env.XDG_CACHE_HOME || join(env.HOME || "/tmp", ".cache");
  const key = new Bun.CryptoHasher("sha256")
    .update(`${FORMAT}\0${Bun.version}\0${nodeEnv}\0${entry}`)
    .digest("hex")
    .slice(0, 24);
  return join(root, "mirin-metal", "bundles", key);
}

export function stamp(path: string): Input {
  const file = Bun.file(path);
  return [path, file.size, file.lastModified];
}

/** The configuration files on the way from the entry's directory to the root. */
export function configsAbove(entry: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    for (const name of CONFIGS) found.push(join(dir, name));
    if (dirname(dir) === dir) return found;
  }
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const value: unknown = await Bun.file(join(dir, "manifest.json")).json();
    if (typeof value !== "object" || value === null) return null;
    const manifest = value as Partial<Manifest>;
    if (
      manifest.format !== FORMAT ||
      typeof manifest.bun !== "string" ||
      typeof manifest.entry !== "string" ||
      typeof manifest.nodeEnv !== "string" ||
      !(manifest.bundle === null || typeof manifest.bundle === "string") ||
      !Array.isArray(manifest.inputs)
    ) {
      return null;
    }
    const inputs = manifest.inputs.filter(
      (input): input is Input =>
        Array.isArray(input) &&
        typeof input[0] === "string" &&
        typeof input[1] === "number" &&
        typeof input[2] === "number",
    );
    return inputs.length === manifest.inputs.length ? (manifest as Manifest) : null;
  } catch {
    return null;
  }
}

/** What the cache holds for an entry. */
export type CachedBundle =
  | { state: "fresh"; bundle: string }
  | { state: "unbundled"; reason: string }
  | { state: "stale" };

/** The bundle to start `entry` from, if one was built from the files as they are now. */
export async function cachedBundle(
  entry: string,
  nodeEnv: string,
  env: Record<string, string | undefined>,
): Promise<CachedBundle> {
  const dir = bundleDir(entry, nodeEnv, env);
  const manifest = await readManifest(dir);
  if (!manifest || manifest.bun !== Bun.version || manifest.entry !== entry)
    return { state: "stale" };
  if (manifest.nodeEnv !== nodeEnv) return { state: "stale" };
  for (const [path, size, mtimeMs] of manifest.inputs) {
    const [, nowSize, nowMtime] = stamp(path);
    if (nowSize !== size || nowMtime !== mtimeMs) return { state: "stale" };
  }
  if (manifest.bundle === null) return { state: "unbundled", reason: manifest.reason ?? "" };
  const bundle = join(dir, manifest.bundle);
  return stamp(bundle)[1] > 0 ? { state: "fresh", bundle } : { state: "stale" };
}

/** A build started this recently is taken to be still running. */
const BUILDING_MS = 60_000;

/**
 * Claim the build of `entry`'s bundle: false when another start claimed it
 * less than `BUILDING_MS` ago (starts in a row while it is stale build once).
 */
export async function claimBuild(
  entry: string,
  nodeEnv: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const marker = Bun.file(join(bundleDir(entry, nodeEnv, env), "building"));
  if (marker.size > 0 && Date.now() - marker.lastModified < BUILDING_MS) return false;
  try {
    // Makes the directory too.
    await Bun.write(marker, String(process.pid));
    return true;
  } catch {
    return false;
  }
}
