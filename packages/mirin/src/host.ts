/**
 * Host bootstrap — the process main-thread entry (docs/architecture.md §1).
 *
 * Compiled with `bun build --compile` into the bundle's `Contents/MacOS/<exe>`
 * so CEF's library loader can resolve the framework relative to it. It spawns
 * the user's app as a Bun Worker, then hands the main thread to CEF via
 * `mirin_run` (which blocks until quit).
 *
 * Two modes:
 *   - Dev (`mirin dev`): configured via env (MIRIN_CORE / MIRIN_WORKER /
 *     MIRIN_MANIFEST_JSON / MIRIN_DEV_URL); windows load the Vite dev server.
 *   - Production (built .app): no env — paths and the manifest are resolved
 *     from inside the bundle, relative to this executable, and windows load
 *     their `app://` URLs served from Contents/Resources.
 */

import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Core } from "./native.ts";

const exeDir = dirname(process.execPath); // Contents/MacOS
const resourcesDir = join(exeDir, "..", "Resources");

const corePath = process.env.MIRIN_CORE ?? join(exeDir, "libmirin_core.dylib");
const workerPath = process.env.MIRIN_WORKER ?? join(resourcesDir, "worker.js");

if (!existsSync(corePath) || !existsSync(workerPath)) {
  console.error(`[mirin host] missing core (${corePath}) or worker (${workerPath})`);
  process.exit(1);
}

const manifest = JSON.parse(
  process.env.MIRIN_MANIFEST_JSON ?? readManifestFromBundle() ?? "{}",
);

const coreConfig = JSON.parse(
  process.env.MIRIN_CONFIG_JSON ??
    JSON.stringify(process.env.MIRIN_DEV_URL ? {} : { resources_path: resourcesDir }),
);

// Load the native core on the main thread FIRST. The Worker also dlopens the
// same dylib in its boot; doing the main-thread dlopen before spawning the
// Worker serializes the first-time load instead of racing two concurrent
// dlopens across threads.
const core = new Core(corePath);

const worker = new Worker(workerPath, {
  workerData: { corePath, manifest, devUrl: process.env.MIRIN_DEV_URL },
});
worker.on("error", (err) => console.error("[mirin worker]", err));

// Hand the main thread to CEF. Blocks in the message loop until the app quits.
const exitCode = core.run(JSON.stringify(coreConfig));

void worker.terminate();
process.exit(exitCode);

function readManifestFromBundle(): string | undefined {
  const path = join(resourcesDir, "mirin.manifest.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
