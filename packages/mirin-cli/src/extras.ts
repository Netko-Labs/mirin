/**
 * Shared helpers for the two "extra asset" config blocks — `sidecars` (bundled
 * binaries) and `workers` (extra Bun Worker entries) — used by both `mirin build`
 * and `mirin dev`. Keeps the config normalization + worker compilation in one
 * place so the two CLI paths stay in sync.
 */

import { $ } from "bun";
import { join } from "node:path";

/** Config shapes (mirrors packages/mirin/src/config.ts; CLI can't import the runtime). */
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

/** Resolve `config.sidecars` to absolute source paths. */
export function normalizeSidecars(
  projectDir: string,
  sidecars: SidecarConfig | undefined,
): NormalizedSidecar[] {
  return Object.entries(sidecars ?? {}).map(([name, value]) => {
    const spec = typeof value === "string" ? { bin: value } : value;
    return {
      name,
      src: join(projectDir, spec.bin),
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
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(workers ?? {})) {
    const js = join(outDir, `${name}.js`);
    const src = join(projectDir, entry);
    if (minify) {
      await $`bun build ${src} --target=bun --minify --outfile ${js}`.cwd(projectDir);
    } else {
      await $`bun build ${src} --target=bun --outfile ${js}`.cwd(projectDir);
    }
    out[name] = js;
  }
  return out;
}
