/**
 * Shared helpers for the two "extra asset" config blocks — `sidecars` (bundled
 * binaries) and `workers` (extra Bun Worker entries) — used by both `mirin build`
 * and `mirin dev`. Keeps source validation and worker compilation in sync.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  assertProjectFile,
  canonicalProjectRoot,
  resolveProjectFile,
  validateOwnedOutputDirectory,
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
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const MAX_EXTRA_NAME_LENGTH = 120;

/** Validate a Windows-portable bundle filename segment used by extra assets. */
export function safeExtraAssetName(name: string, label: string): string {
  if (
    name.length > MAX_EXTRA_NAME_LENGTH ||
    !SAFE_EXTRA_NAME.test(name) ||
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    WINDOWS_RESERVED_NAME.test(name)
  ) {
    throw new Error(
      `[mirin] invalid ${label} "${name}" — use at most ${MAX_EXTRA_NAME_LENGTH} letters, ` +
        'digits, ".", "_" or "-" in one Windows-portable, non-reserved segment.',
    );
  }
  return name;
}

function assertUniqueExtraAssetNames(names: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`[mirin] duplicate ${label} "${name}" under case-insensitive filenames.`);
    }
    seen.add(key);
  }
}

/** Resolve `config.sidecars` to canonical regular source files under the project root. */
export function normalizeSidecars(
  projectDir: string,
  sidecars: SidecarConfig | undefined,
): NormalizedSidecar[] {
  const root = canonicalProjectRoot(projectDir);
  const entries = Object.entries(sidecars ?? {}).map(([name, value]) => ({
    name: safeExtraAssetName(name, "sidecar name"),
    value,
  }));
  assertUniqueExtraAssetNames(
    entries.map(({ name }) => name),
    "sidecar name",
  );
  return entries.map(({ name, value }) => {
    const spec = typeof value === "string" ? { bin: value } : value;
    return {
      name,
      src: resolveProjectFile(root, spec.bin, `sidecar "${name}" path`),
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
  const entries = Object.entries(workers ?? {}).map(([name, entry]) => ({
    name: safeExtraAssetName(name, "worker name"),
    entry,
  }));
  assertUniqueExtraAssetNames(
    entries.map(({ name }) => name),
    "worker name",
  );
  return entries.map(({ name, entry }) => ({
    name,
    src: resolveProjectFile(root, entry, `worker "${name}" entry`),
  }));
}

/** Revalidate extra names and project-owned sources before bundle cleanup. */
export function validateBundleExtras(
  projectDir: string,
  sidecars: readonly { name: string; src: string }[] | undefined,
  workers: Readonly<Record<string, string>> | undefined,
): void {
  const root = canonicalProjectRoot(projectDir);
  const safeSidecars = (sidecars ?? []).map((sidecar) => ({
    ...sidecar,
    name: safeExtraAssetName(sidecar.name, "sidecar name"),
  }));
  const safeWorkers = Object.entries(workers ?? {}).map(([name, source]) => ({
    name: safeExtraAssetName(name, "worker name"),
    source,
  }));
  assertUniqueExtraAssetNames(
    safeSidecars.map(({ name }) => name),
    "sidecar name",
  );
  assertUniqueExtraAssetNames(
    safeWorkers.map(({ name }) => name),
    "worker name",
  );
  for (const sidecar of safeSidecars) {
    assertProjectFile(root, sidecar.src, `sidecar "${sidecar.name}"`);
  }
  for (const worker of safeWorkers) {
    assertProjectFile(root, worker.source, `worker "${worker.name}" bundle`);
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
  const root = canonicalProjectRoot(projectDir);
  const names = workers.map((worker) => safeExtraAssetName(worker.name, "worker name"));
  assertUniqueExtraAssetNames(names, "worker name");
  const output = validateOwnedOutputDirectory(root, outDir, "worker output directory");
  mkdirSync(output, { recursive: true });
  const compiled = workers.map(async (worker) => {
    const name = safeExtraAssetName(worker.name, "worker name");
    const src = assertProjectFile(root, worker.src, `worker "${name}" entry`);
    const js = join(output, `${name}.js`);
    if (minify) {
      await $`bun build ${src} --target=bun --minify --outfile ${js}`.cwd(root);
    } else {
      await $`bun build ${src} --target=bun --outfile ${js}`.cwd(root);
    }
    return { name, js };
  });

  const out: Record<string, string> = {};
  for (const worker of await Promise.all(compiled)) {
    out[worker.name] = worker.js;
  }
  return out;
}
