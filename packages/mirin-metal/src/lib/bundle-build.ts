/**
 * Building the bundle `mirin-metal run` starts an app from
 * (`bundle-cache.ts` has what is kept and when it is used). Run in a process
 * of its own, after the app it was started beside (`cli.ts`).
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bundleDir,
  type CachedBundle,
  configsAbove,
  dirname,
  FORMAT,
  type Input,
  join,
  type Manifest,
  stamp,
} from "./bundle-cache.ts";

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
