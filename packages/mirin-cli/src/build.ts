/**
 * `mirin build` — package a standalone, signed .app (docs/macos-mvp.md).
 *
 * 1. vite build               → production UI in dist/
 * 2. resolve native artifacts → core + helper (in-repo build or prebuilt)
 * 3. compile host (minified)  → Contents/MacOS/<exe>
 * 4. bundle Worker (minified) → Resources/worker.js
 * 5. assemble + sign the .app → dist/ui, manifest, dylib, helpers, CEF
 *
 * The result runs with no env and no dev server: the host resolves everything
 * from inside the bundle, and webviews load their `app://` URLs served from
 * Contents/Resources by the native scheme handler.
 *
 * Codesign identity: ad-hoc by default; set MIRIN_SIGN_IDENTITY to a Developer
 * ID to produce a distributable, notarizable app.
 */

import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildAppBundle } from "./bundle.ts";
import { resolveArtifacts } from "./artifacts.ts";

export async function build(projectDir = process.cwd()): Promise<number> {
  const outDir = join(projectDir, "build");
  const work = join(projectDir, ".mirin");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });

  const config = (await import(join(projectDir, "mirin.config.ts"))).default;
  const appName: string = config.name ?? "Mirin App";
  const bundleId: string = config.id ?? "dev.mirin.app";
  const mainEntry = join(projectDir, config.main ?? "main/main.ts");

  console.log(`[mirin build] ${appName}`);

  // 1. production UI
  console.log("[mirin build] vite build…");
  await $`bunx vite build`.cwd(projectDir);

  // 2. native artifacts (release)
  const artifacts = await resolveArtifacts({ release: true });

  // 3 + 4. host + worker (minified)
  console.log("[mirin build] compiling host + bundling main process…");
  const hostExe = join(work, "host-release");
  const workerJs = join(work, "worker.release.js");
  await $`bun build --compile --minify ${artifacts.hostEntry} --outfile ${hostExe}`.cwd(projectDir);
  await $`bun build ${mainEntry} --target=bun --minify --outfile ${workerJs}`.cwd(projectDir);

  // 5. assemble + sign
  console.log("[mirin build] assembling .app…");
  rmSync(join(outDir, `${appName}.app`), { recursive: true, force: true });
  const { app } = await buildAppBundle({
    appName,
    bundleId,
    outDir,
    hostExe,
    coreDylib: artifacts.coreDylib,
    helperBin: artifacts.helperBin,
    cefPath: artifacts.cefPath,
    signIdentity: process.env.MIRIN_SIGN_IDENTITY,
    resources: {
      uiDir: join(projectDir, "dist"),
      workerJs,
      manifestJson: JSON.stringify({ windows: config.windows }),
    },
  });

  console.log(`\n[mirin build] done → ${app}`);
  console.log(`  open "${app}"`);
  return 0;
}
