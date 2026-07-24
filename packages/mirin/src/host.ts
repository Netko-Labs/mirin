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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { resolveHostSingleInstance } from "./host-config.ts";
import { Core } from "./native.ts";
import {
  EXCLUSIVE_UPDATER_CAPABILITY,
  HOST_RUNTIME_PROTOCOL,
  inspectUpdateHandoff,
  UPDATE_HANDOFF_TOKEN_ENV,
} from "./update-handoff.ts";

// Bundle layout differs by platform: macOS `.app` puts the host in
// `Contents/MacOS` with resources in `../Resources`; Windows and Linux are flat app
// folders where the host binary sits beside the core lib (`mirin_core.dll` /
// `libmirin_core.so`) with resources in `resources/`.
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const exeDir = dirname(process.execPath);
const resourcesDir = isMac ? join(exeDir, "..", "Resources") : join(exeDir, "resources");

const coreFileName = isWindows
  ? "mirin_core.dll"
  : isMac
    ? "libmirin_core.dylib"
    : "libmirin_core.so";
const corePath = process.env.MIRIN_CORE ?? join(exeDir, coreFileName);
const workerPath = process.env.MIRIN_WORKER ?? join(resourcesDir, "worker.js");
// Bundled-asset dirs for sidecars (Bun.spawn binaries) and extra workers. Dev
// overrides via env (dev.ts stages them under .mirin); prod resolves in-bundle.
const sidecarDir = process.env.MIRIN_SIDECAR_DIR ?? join(resourcesDir, "sidecars");
const workersDir = process.env.MIRIN_WORKERS_DIR ?? join(resourcesDir, "workers");

if (!existsSync(corePath) || !existsSync(workerPath)) {
  console.error(`[mirin host] missing core (${corePath}) or worker (${workerPath})`);
  process.exit(1);
}

const manifest = JSON.parse(process.env.MIRIN_MANIFEST_JSON ?? readManifestFromBundle() ?? "{}");

const coreConfig = JSON.parse(
  process.env.MIRIN_CONFIG_JSON ??
    JSON.stringify(process.env.MIRIN_DEV_URL ? { dev: true } : { resources_path: resourcesDir }),
);
// Resolve one value for both the native host and Worker. The internal native
// override must not leave the updater believing single-instance is still active.
const singleInstance = resolveHostSingleInstance(
  manifest.singleInstance,
  coreConfig.single_instance,
);
coreConfig.single_instance = singleInstance;
// The app's bundle id keys the per-app CEF cache dir (Windows has no OS bundle id).
if (typeof manifest.id === "string") coreConfig.identifier = manifest.id;
// Linux prod: the CLI stages the resolved app icon at resources/icon.png; the core
// stamps it onto each window as `_NET_WM_ICON` (taskbar/dock). Dev supplies this via
// MIRIN_CONFIG_JSON instead. macOS/Windows take the icon from the bundle.
if (process.platform === "linux" && !coreConfig.icon_path) {
  const iconPng = join(resourcesDir, "icon.png");
  if (existsSync(iconPng)) coreConfig.icon_path = iconPng;
}

const updateHandoffToken = process.env[UPDATE_HANDOFF_TOKEN_ENV];
delete process.env[UPDATE_HANDOFF_TOKEN_ENV];
const handoff =
  typeof manifest.id === "string"
    ? inspectUpdateHandoff(manifest.id, resourcesDir, Boolean(coreConfig.dev), updateHandoffToken)
    : { blocked: false };
if (handoff.blocked) {
  console.error("[mirin host] an updater owns the app launch handoff");
  process.exit(0);
}

// Load the native core on the main thread FIRST. The Worker also dlopens the
// same dylib in its boot; doing the main-thread dlopen before spawning the
// Worker serializes the first-time load instead of racing two concurrent
// dlopens across threads.
const core = new Core(corePath);
const instanceLock = core.acquireInstanceLock(JSON.stringify(coreConfig));
if (!instanceLock) {
  console.error("[mirin host] another app instance owns an incompatible process lock");
  process.exit(0);
}
const singleInstanceAcquired = instanceLock === "exclusive";
if (handoff.readyPath && !singleInstanceAcquired) {
  console.error("[mirin host] updater replacement did not acquire the exclusive app lock");
  process.exit(1);
}

const worker = new Worker(workerPath, {
  workerData: {
    corePath,
    manifest,
    // Legacy Workers must fail closed under version skew. Current Workers only
    // trust the versioned positive capability below.
    singleInstance: false,
    runtimeProtocol: HOST_RUNTIME_PROTOCOL,
    updaterApplyCapability: singleInstanceAcquired ? EXCLUSIVE_UPDATER_CAPABILITY : undefined,
    updateReadyPath: singleInstanceAcquired ? handoff.readyPath : undefined,
    id: typeof manifest.id === "string" ? manifest.id : undefined,
    devUrl: process.env.MIRIN_DEV_URL,
    resourcesDir,
    sidecarDir,
    workersDir,
  },
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
