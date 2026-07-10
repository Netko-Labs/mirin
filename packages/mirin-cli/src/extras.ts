/**
 * Shared helpers for the two "extra asset" config blocks — `sidecars` (bundled
 * binaries) and `workers` (extra Bun Worker entries) — used by both `mirin build`
 * and `mirin dev`. Keeps the config normalization + worker compilation in one
 * place so the two CLI paths stay in sync.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { $ } from "bun";

/** Config shapes (mirrors packages/mirin/src/config/index.ts; CLI can't import the runtime). */
export type SidecarConfig = Record<string, string | { bin: string; entitlements?: string[] }>;
export type WorkersConfig = Record<string, string>;

/** A sidecar resolved to an absolute source path + its requested entitlements. */
export interface NormalizedSidecar {
  name: string;
  /** Absolute path to the source binary. */
  src: string;
  /** Short entitlement names (e.g. "allow-jit"); empty for most CLIs. */
  entitlements: string[];
}

const SAFE_EXTRA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Extra asset names become bundle filenames, so keep them as path segments. This
 * prevents config keys such as "../tool" from escaping resources/sidecars or
 * resources/workers in dev and production bundles.
 */
export function safeExtraAssetName(name: string, label: string): string {
  if (!SAFE_EXTRA_NAME.test(name) || name === "." || name === "..") {
    throw new Error(
      `[mirin] invalid ${label} "${name}" — use letters, digits, ".", "_" or "-", ` +
        "and do not include path separators.",
    );
  }
  return name;
}

function projectRelativePath(projectDir: string, file: string, label: string): string {
  if (isAbsolute(file)) {
    throw new Error(`[mirin] ${label} must be relative to the project root: ${file}`);
  }
  const root = resolve(projectDir);
  const full = resolve(root, file);
  const rel = relative(root, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`[mirin] ${label} escapes the project root: ${file}`);
  }
  return full;
}

/** Resolve `config.sidecars` to absolute source paths. */
export function normalizeSidecars(
  projectDir: string,
  sidecars: SidecarConfig | undefined,
): NormalizedSidecar[] {
  return Object.entries(sidecars ?? {}).map(([name, value]) => {
    const safeName = safeExtraAssetName(name, "sidecar name");
    const spec = typeof value === "string" ? { bin: value } : value;
    return {
      name: safeName,
      src: projectRelativePath(projectDir, spec.bin, `sidecar "${safeName}" path`),
      entitlements: spec.entitlements ?? [],
    };
  });
}

/**
 * Compile each extra-worker entry to `<outDir>/<name>.js`. Returns name → path.
 * `minify` matches the surrounding build (prod minifies; dev doesn't).
 */
export async function compileWorkers(
  projectDir: string,
  workers: WorkersConfig | undefined,
  outDir: string,
  minify: boolean,
): Promise<Record<string, string>> {
  mkdirSync(outDir, { recursive: true });
  const out: Record<string, string> = {};
  const compiled = Object.entries(workers ?? {}).map(async ([name, entry]) => {
    const safeName = safeExtraAssetName(name, "worker name");
    const js = join(outDir, `${safeName}.js`);
    const src = projectRelativePath(projectDir, entry, `worker "${safeName}" entry`);
    if (minify) {
      await $`bun build ${src} --target=bun --minify --outfile ${js}`.cwd(projectDir);
    } else {
      await $`bun build ${src} --target=bun --outfile ${js}`.cwd(projectDir);
    }
    return { name: safeName, js };
  });
  for (const worker of await Promise.all(compiled)) {
    out[worker.name] = worker.js;
  }
  return out;
}
