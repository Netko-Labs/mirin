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
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Bumped when what is built, or how it is checked, changes. */
const FORMAT = 1;

/** A file the bundle depends on: its path, size and modification time (-1 when it didn't exist). */
type Input = [path: string, size: number, mtimeMs: number];

interface Manifest {
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
  const root = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  const key = new Bun.CryptoHasher("sha256")
    .update(`${FORMAT}\0${Bun.version}\0${nodeEnv}\0${entry}`)
    .digest("hex")
    .slice(0, 24);
  return join(root, "mirin-metal", "bundles", key);
}

function stamp(path: string): Input {
  try {
    const stats = statSync(path);
    return [path, stats.size, stats.mtimeMs];
  } catch {
    return [path, -1, -1];
  }
}

/** The configuration files on the way from the entry's directory to the root. */
function configsAbove(entry: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    for (const name of CONFIGS) found.push(join(dir, name));
    if (dirname(dir) === dir) return found;
  }
}

function readManifest(dir: string): Manifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
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
export function cachedBundle(
  entry: string,
  nodeEnv: string,
  env: Record<string, string | undefined>,
): CachedBundle {
  const dir = bundleDir(entry, nodeEnv, env);
  const manifest = readManifest(dir);
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
export function claimBuild(
  entry: string,
  nodeEnv: string,
  env: Record<string, string | undefined>,
): boolean {
  const dir = bundleDir(entry, nodeEnv, env);
  const marker = join(dir, "building");
  const [, size, mtimeMs] = stamp(marker);
  if (size >= 0 && Date.now() - mtimeMs < BUILDING_MS) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

/** `import.meta`'s fields, as the module at `path` has them when run from its source. */
function metaOf(path: string, entry: string): Record<string, string> {
  const dir = JSON.stringify(dirname(path));
  const file = JSON.stringify(path);
  return Object.fromEntries([
    ["import.meta.url", JSON.stringify(pathToFileURL(path).href)],
    ["import.meta.dir", dir],
    ["import.meta.dirname", dir],
    ["import.meta.path", file],
    ["import.meta.filename", file],
    ["import.meta.main", String(path === entry)],
    ["__dirname", dir],
    ["__filename", file],
  ]);
}

const META =
  /\bimport\.meta\.(?:url|dirname|dir|path|filename|main)\b|(?<![\w$.])__(?:dirname|filename)(?![\w$])/g;

/**
 * What resolves a path from the module's own place at run time: an
 * `import(` or `require(` whose argument is not a plain string, a
 * `require.resolve` or `import.meta.resolve`, a `new Worker`. In a bundle it
 * would resolve from the bundle's directory.
 */
const RUNTIME_PATH =
  /\b(?:import|require)\s*\(\s*(?!["'][^"'`$\\]*["']\s*[,)])|\brequire\.resolve\b|\bimport\.meta\.resolve\b|\bnew\s+Worker\b/;

type Loader = "js" | "jsx" | "ts" | "tsx";

function loaderOf(path: string): Loader | null {
  if (/\.tsx$/.test(path)) return "tsx";
  if (/\.[cm]?ts$/.test(path)) return "ts";
  if (/\.jsx$/.test(path)) return "jsx";
  if (/\.[cm]?js$/.test(path)) return "js";
  return null;
}

/** Why a module stops the app from running as a bundle; null when it doesn't. */
export function unbundleable(code: string, loader: Loader): string | null {
  // Transpiled first: comments and types are gone, so what is left is code
  // (and strings, which can only make this say no where yes was right).
  const plain = new Bun.Transpiler({ loader }).transformSync(code);
  // `import.meta.require(…)` is a `require(…)`: the same test.
  return RUNTIME_PATH.test(plain.replace(/\bimport\.meta\.require\b/g, "require"))
    ? "a path resolved at run time (import(), require(), require.resolve, import.meta.resolve, new Worker)"
    : null;
}

/**
 * `code` with its module's own `import.meta` fields written in, or null
 * when that can't be done exactly: the text replaced must be the code the
 * transpiler replaces given the same values (no string spells one).
 */
export function withOwnMeta(
  code: string,
  loader: Loader,
  path: string,
  entry: string,
): string | null {
  if (
    !code.includes("import.meta") &&
    !code.includes("__dirname") &&
    !code.includes("__filename")
  ) {
    return code;
  }
  const meta = metaOf(path, entry);
  const written = code.replace(META, (match) => meta[match] ?? match);
  const defined = new Bun.Transpiler({ loader, define: meta }).transformSync(code);
  let replaced: string;
  try {
    replaced = new Bun.Transpiler({ loader }).transformSync(written);
  } catch {
    // A value written into a string or a template can leave it unparsable.
    return null;
  }
  return defined === replaced ? written : null;
}

/** Build the bundle for `entry` and write it and its manifest to the cache. */
export async function buildBundle(
  entry: string,
  nodeEnv: string,
  env: Record<string, string | undefined>,
): Promise<CachedBundle> {
  const dir = bundleDir(entry, nodeEnv, env);
  let reason: string | null = null;
  // Each module's file as it was before it was read, so a change made
  // while this builds leaves the bundle stale.
  const read = new Map<string, Input>();
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    minify: true,
    metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    plugins: [
      {
        name: "mirin-metal-own-meta",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
            const loader = loaderOf(args.path) ?? "js";
            read.set(args.path, stamp(args.path));
            const code = await Bun.file(args.path).text();
            let own: string | null = code;
            try {
              const why = unbundleable(code, loader);
              if (why) reason ??= `${args.path}: ${why}`;
              own = withOwnMeta(code, loader, args.path, entry);
              if (own === null) reason ??= `${args.path}: import.meta it can't write in`;
            } catch (error) {
              reason ??= `${args.path}: ${String(error)}`;
            }
            return { contents: own ?? code, loader };
          });
        },
      },
    ],
  });
  if (!result.success) reason ??= `the build failed: ${result.logs.map(String).join("; ")}`;
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map((path) => resolve(path));
  const stamps = [...new Set([...inputs, ...configsAbove(entry)])].map(
    (path) => read.get(path) ?? stamp(path),
  );
  const manifest: Manifest = {
    format: FORMAT,
    bun: Bun.version,
    entry,
    nodeEnv,
    bundle: reason === null ? "app.js" : null,
    ...(reason === null ? {} : { reason }),
    inputs: stamps,
  };
  mkdirSync(dir, { recursive: true });
  // Written beside and renamed over, so a start never reads half of either.
  const unique = `${process.pid}-${Date.now()}`;
  const output = result.outputs[0];
  if (manifest.bundle && output) {
    writeFileSync(join(dir, `app.js.${unique}`), await output.text());
    renameSync(join(dir, `app.js.${unique}`), join(dir, "app.js"));
  }
  writeFileSync(join(dir, `manifest.json.${unique}`), JSON.stringify(manifest));
  renameSync(join(dir, `manifest.json.${unique}`), join(dir, "manifest.json"));
  rmSync(join(dir, "building"), { force: true });
  return manifest.bundle
    ? { state: "fresh", bundle: join(dir, "app.js") }
    : { state: "unbundled", reason: manifest.reason ?? "" };
}
