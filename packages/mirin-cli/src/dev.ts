/**
 * `mirin dev` — the development loop (docs/macos-mvp.md, M4).
 *
 * 1. resolve native artifacts (build in-repo, or prebuilt when installed)
 * 2. compile the Bun host, bundle the user's main-process Worker
 * 3. assemble + ad-hoc-sign the dev .app
 * 4. start the Vite dev server (rolldown-vite) for the UI
 * 5. launch the app pointed at the Vite URL, with RPC injected into the webview
 */

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildAppBundle } from "./bundle.ts";
import { resolveArtifacts } from "./artifacts.ts";
import { sweepBuildTemps } from "./temps.ts";

const DEV_URL = "http://localhost:5173";

export async function dev(projectDir = process.cwd()): Promise<number> {
  const work = join(projectDir, ".mirin");
  mkdirSync(work, { recursive: true });
  // `bun build --compile` drops temp *.bun-build files in the cwd; clear any left
  // behind by a previously interrupted run so they don't pile up in the project.
  sweepBuildTemps(projectDir);

  // --- load the manifest ---
  const config = (await import(join(projectDir, "mirin.config.ts"))).default;
  const appName: string = config.name ?? "Mirin App";
  const bundleId: string = config.id ?? "dev.mirin.app";
  const mainEntry = join(projectDir, config.main ?? "main/main.ts");

  // --- native artifacts ---
  const artifacts = await resolveArtifacts({ release: false });

  // --- compile the Bun host + bundle the Worker ---
  console.log("[mirin dev] compiling host + bundling main process…");
  const hostExe = join(work, "host");
  const workerJs = join(work, "worker.js");
  await $`bun build --compile ${artifacts.hostEntry} --outfile ${hostExe}`.cwd(projectDir);
  await $`bun build ${mainEntry} --target=bun --outfile ${workerJs}`.cwd(projectDir);

  // --- assemble the dev .app ---
  console.log("[mirin dev] assembling dev bundle…");
  const { app, exe } = await buildAppBundle({
    appName,
    bundleId,
    outDir: work,
    hostExe,
    coreDylib: artifacts.coreDylib,
    helperBin: artifacts.helperBin,
    cefPath: artifacts.cefPath,
    icon: config.icon ? join(projectDir, config.icon) : undefined,
  });

  // --- start Vite ---
  console.log("[mirin dev] starting Vite dev server…");
  const vite = Bun.spawn(["bunx", "vite", "--clearScreen", "false"], {
    cwd: projectDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForUrl(DEV_URL, 15_000);

  // --- launch the app ---
  console.log(`[mirin dev] launching ${appName}…`);
  const appProc = Bun.spawn([exe], {
    cwd: projectDir,
    env: {
      ...process.env,
      MIRIN_CORE: join(app, "Contents", "MacOS", "libmirin_core.dylib"),
      MIRIN_WORKER: workerJs,
      MIRIN_DEV_URL: DEV_URL,
      MIRIN_MANIFEST_JSON: JSON.stringify({ windows: config.windows }),
      MIRIN_CONFIG_JSON: "{}",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const cleanup = () => {
    vite.kill();
    appProc.kill();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await appProc.exited;
  vite.kill();
  return code;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`Vite dev server did not start at ${url} within ${timeoutMs}ms`);
}
