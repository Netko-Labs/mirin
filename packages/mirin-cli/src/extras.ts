/**
 * Shared helpers for the two "extra asset" config blocks — `sidecars` (bundled
 * binaries) and `workers` (extra Bun Worker entries) — used by both `mirin build`
 * and `mirin dev`. Keeps source validation and worker compilation in sync.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  assertRegularFile,
  canonicalProjectRoot,
  resolveProjectFile,
} from "./shared/fs/project-source.ts";

/** Config shapes (mirrors packages/mirin/src/config; CLI can't import runtime internals). */
export type SidecarConfig = Record<string, string | { bin: string; entitlements?: string[] }>;
export type WorkersConfig = Record<string, string>;

/** A sidecar resolved to a canonical source path + its requested entitlements. */
export interface NormalizedSidecar {
  name: string;
  /** Canonical absolute path to a regular source file inside the project root. */
  src: string;
  /** Short entitlement names (e.g. "allow-jit"); empty for most CLIs. */
  entitlements: string[];
}

/** An extra Worker resolved to a canonical regular source file. */
export interface NormalizedWorker {
  name: string;
  src: string;
}

const SAFE_EXTRA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a bundle filename segment used by sidecars and extra workers. */
export function safeExtraAssetName(name: string, label: string): string {
  if (!SAFE_EXTRA_NAME.test(name) || name === "." || name === "..") {
    throw new Error(
      `[mirin] invalid ${label} "${name}" — use letters, digits, ".", "_" or "-", ` +
        "and do not include path separators.",
    );
  }
  return name;
}

/** Resolve `config.sidecars` to canonical regular source files under the project root. */
export function normalizeSidecars(
  projectDir: string,
  sidecars: SidecarConfig | undefined,
): NormalizedSidecar[] {
  const root = canonicalProjectRoot(projectDir);
  return Object.entries(sidecars ?? {}).map(([name, value]) => {
    const safeName = safeExtraAssetName(name, "sidecar name");
    const spec = typeof value === "string" ? { bin: value } : value;
    return {
      name: safeName,
      src: resolveProjectFile(root, spec.bin, `sidecar "${safeName}" path`),
      entitlements: spec.entitlements ?? [],
    };
  });
}

/** Resolve `config.workers` to canonical regular entry files under the project root. */
export function normalizeWorkers(
  projectDir: string,
  workers: WorkersConfig | undefined,
): NormalizedWorker[] {
  const root = canonicalProjectRoot(projectDir);
  return Object.entries(workers ?? {}).map(([name, entry]) => {
    const safeName = safeExtraAssetName(name, "worker name");
    return {
      name: safeName,
      src: resolveProjectFile(root, entry, `worker "${safeName}" entry`),
    };
  });
}

/** Revalidate extra names and regular sources before a bundle directory is removed. */
export function validateBundleExtras(
  sidecars: readonly { name: string; src: string }[] | undefined,
  workers: Readonly<Record<string, string>> | undefined,
): void {
  for (const sidecar of sidecars ?? []) {
    const name = safeExtraAssetName(sidecar.name, "sidecar name");
    assertRegularFile(sidecar.src, `sidecar "${name}"`);
  }
  for (const [workerName, source] of Object.entries(workers ?? {})) {
    const name = safeExtraAssetName(workerName, "worker name");
    assertRegularFile(source, `worker "${name}" bundle`);
  }
}

/**
 * Compile each validated extra-worker entry to `<outDir>/<name>.js`. Returns
 * name → output path. `minify` matches the surrounding build.
 */
export async function compileWorkers(
  projectDir: string,
  workers: readonly NormalizedWorker[],
  outDir: string,
  minify: boolean,
): Promise<Record<string, string>> {
  const sources = workers.map((worker) => ({
    ...worker,
    src: assertRegularFile(worker.src, `worker "${worker.name}" entry`),
  }));
  mkdirSync(outDir, { recursive: true });
  const compiled = sources.map(async ({ name, src }) => {
    const js = join(outDir, `${name}.js`);
    if (minify) {
      await $`bun build ${src} --target=bun --minify --outfile ${js}`.cwd(projectDir);
    } else {
      await $`bun build ${src} --target=bun --outfile ${js}`.cwd(projectDir);
    }
    return { name, js };
  });

  const out: Record<string, string> = {};
  for (const worker of await Promise.all(compiled)) {
    out[worker.name] = worker.js;
  }
  return out;
}
