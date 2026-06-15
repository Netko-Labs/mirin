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
import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { buildAppBundle } from "./bundle.ts";
import { resolveArtifacts } from "./artifacts.ts";
import { sweepBuildTemps } from "./temps.ts";
import { normalizeSidecars, compileWorkers } from "./extras.ts";

/** Vite's default port. `mirin dev` probes upward from here for a free one, so a
 *  second dev session (or anything already on 5173) doesn't collide. */
const DEV_PORT_BASE = 5173;

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

  // Extra assets (dev): compile workers into .mirin/workers and symlink sidecar
  // binaries into .mirin/sidecars (no copy/sign in dev — they run unsigned locally).
  const workersDir = join(work, "workers");
  await compileWorkers(projectDir, config.workers, workersDir, false);
  const sidecarsDir = join(work, "sidecars");
  mkdirSync(sidecarsDir, { recursive: true });
  for (const sc of normalizeSidecars(projectDir, config.sidecars)) {
    const link = join(sidecarsDir, sc.name);
    rmSync(link, { force: true });
    if (existsSync(sc.src)) symlinkSync(sc.src, link);
    else console.warn(`[mirin dev] sidecar "${sc.name}" not found: ${sc.src}`);
  }

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
    urlSchemes: config.urlSchemes,
  });

  // --- start Vite on a free port so concurrent dev sessions don't collide ---
  // `--port <free> --strictPort` pins Vite to the port we probed (overriding any
  // port/strictPort in the app's vite.config) and passes the real URL to the app,
  // so the host and Vite never disagree about which port is in use.
  const port = await findFreePort(DEV_PORT_BASE);
  const devUrl = `http://localhost:${port}`;
  console.log(`[mirin dev] starting Vite dev server on ${devUrl}…`);
  const vite = Bun.spawn(
    ["bunx", "vite", "--clearScreen", "false", "--port", String(port), "--strictPort"],
    {
      cwd: projectDir,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitForUrl(devUrl, 15_000);

  // --- launch the app ---
  console.log(`[mirin dev] launching ${appName}…`);
  const appProc = Bun.spawn([exe], {
    cwd: projectDir,
    env: {
      ...process.env,
      MIRIN_CORE: join(app, "Contents", "MacOS", "libmirin_core.dylib"),
      MIRIN_WORKER: workerJs,
      MIRIN_DEV_URL: devUrl,
      MIRIN_MANIFEST_JSON: JSON.stringify({ windows: config.windows }),
      // dev: true → enables inspect-element AND gives this run its own `-dev`
      // CEF cache dir, so `mirin dev` can run alongside the installed app.
      MIRIN_CONFIG_JSON: JSON.stringify({ dev: true }),
      MIRIN_SIDECAR_DIR: sidecarsDir,
      MIRIN_WORKERS_DIR: workersDir,
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

/** First free TCP port at or above `start` on loopback. */
async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`[mirin dev] no free port in ${start}–${start + 99}`);
}

/** Free only if neither IPv4 nor IPv6 loopback reports the port in use — Vite
 *  binds `localhost` (often `::1`), so a v4-only probe would miss an IPv6 holder. */
async function isPortFree(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([portInUse(port, "127.0.0.1"), portInUse(port, "::1")]);
  return !v4 && !v6;
}

function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    // Only EADDRINUSE means taken; other errors (e.g. EADDRNOTAVAIL when IPv6 is
    // off) just mean we can't test that family — treat as not-in-use.
    srv.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE"));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, host);
  });
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
