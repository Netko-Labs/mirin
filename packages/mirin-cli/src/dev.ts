/**
 * `mirin dev` — the development loop (docs/macos-mvp.md, M4).
 *
 * 1. resolve native artifacts (build in-repo, or prebuilt when installed)
 * 2. compile the Bun host, bundle the user's main-process Worker
 * 3. assemble + ad-hoc-sign the dev .app
 * 4. start the Vite dev server (rolldown-vite) for the UI
 * 5. launch the app pointed at the Vite URL, with RPC injected into the webview
 *
 * Each run also opens a dev session under `.mirin/dev/` and records its phase
 * timeline there, so the app's structured event stream and this startup sequence
 * can be read from disk without a terminal (docs/agent-devtools.md).
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { resolveArtifacts } from "./artifacts.ts";
import {
  buildLinuxBundle,
  desktopEntry,
  resolveLinuxDesktopIconPng,
  resolveLinuxIconPng,
} from "./bundle/linux/index.ts";
import { buildAppBundle } from "./bundle/macos/index.ts";
import { buildWindowsBundle } from "./bundle/windows/index.ts";

const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

import { compileWorkers, normalizeSidecars } from "./extras.ts";
import { DevSession } from "./shared/session.ts";
import { sweepBuildTemps } from "./temps.ts";

/** Vite's default port. `mirin dev` probes upward from here for a free one, so a
 *  second dev session (or anything already on 5173) doesn't collide. */
const DEV_PORT_BASE = 5173;

/** Where the CEF DevTools-protocol port search starts. Well clear of Vite's range
 *  so concurrent dev sessions of different apps don't fight over either. */
const CDP_PORT_BASE = 9222;

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
  const iconSrc = config.icon ? join(projectDir, config.icon) : undefined;
  // Linux: resolve the app icon to a concrete PNG the core stamps onto the window
  // as `_NET_WM_ICON` (cosmic dock/taskbar). Passed straight through in dev — no
  // bundling; the file is read from the project at window-create time.
  const linuxIconPng = IS_LINUX && iconSrc ? resolveLinuxIconPng(iconSrc) : undefined;

  // --- open the dev session (agent devtools) ---
  const session = DevSession.create({
    projectDir,
    appName,
    appId: bundleId,
    version: typeof config.version === "string" ? config.version : undefined,
  });

  // --- native artifacts ---
  const artifacts = await resolveArtifacts({ release: false });

  // --- compile the Bun host + bundle the Worker ---
  const compilePhase = session?.phase("compile");
  console.log("[mirin dev] compiling host + bundling main process…");
  // `bun build --compile` emits an `.exe` on Windows; name it so explicitly.
  const hostExe = join(work, IS_WINDOWS ? "host.exe" : "host");
  const workerJs = join(work, "worker.js");
  const hostTarget =
    process.platform === "win32" && process.arch === "arm64" ? ["--target=bun-windows-x64"] : [];
  await $`bun build --compile ${hostTarget} ${artifacts.hostEntry} --outfile ${hostExe}`.cwd(
    projectDir,
  );
  await $`bun build ${mainEntry} --target=bun --outfile ${workerJs}`.cwd(projectDir);
  compilePhase?.ok();

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

  // --- assemble the dev bundle (Windows/Linux app folder, or macOS .app) ---
  const bundlePhase = session?.phase("bundle");
  console.log("[mirin dev] assembling dev bundle…");
  const { app, exe } = IS_WINDOWS
    ? await buildWindowsBundle({
        appName,
        outDir: work,
        hostExe,
        coreDll: artifacts.coreDylib,
        helperExe: artifacts.helperBin,
        cefPath: artifacts.cefPath,
        icon: iconSrc,
      })
    : IS_LINUX
      ? await buildLinuxBundle({
          appName,
          outDir: work,
          hostExe,
          coreDll: artifacts.coreDylib,
          helperExe: artifacts.helperBin,
          cefPath: artifacts.cefPath,
          icon: iconSrc,
        })
      : await buildAppBundle({
          appName,
          bundleId,
          outDir: work,
          hostExe,
          coreDylib: artifacts.coreDylib,
          helperBin: artifacts.helperBin,
          cefPath: artifacts.cefPath,
          icon: iconSrc,
          urlSchemes: config.urlSchemes,
        });
  bundlePhase?.ok();

  // Linux: install a dev `.desktop` entry so cosmic's dock can resolve the app's
  // icon. cosmic matches a running X11 window's `WM_CLASS` (which the core sets to
  // the bundle id) against `StartupWMClass`, then shows that entry's `Icon`. Written
  // to the per-user applications dir; harmless on other DEs.
  if (IS_LINUX && iconSrc) {
    const desktopIcon = resolveLinuxDesktopIconPng(iconSrc);
    if (desktopIcon) {
      const appsDir = join(homedir(), ".local", "share", "applications");
      mkdirSync(appsDir, { recursive: true });
      writeFileSync(
        join(appsDir, `${bundleId}.desktop`),
        desktopEntry({ name: appName, exec: exe, iconPng: desktopIcon, wmClass: bundleId }),
      );
    }
  }

  // --- start Vite on a free port so concurrent dev sessions don't collide ---
  // `--port <free> --strictPort` pins Vite to the port we probed (overriding any
  // port/strictPort in the app's vite.config) and passes the real URL to the app,
  // so the host and Vite never disagree about which port is in use.
  //
  // Bind + address on 127.0.0.1 (IPv4), NOT "localhost": on hosts where Vite binds
  // IPv6-only (`[::1]`) while Chromium resolves `localhost` to IPv4 (common on
  // Linux), the webview's page load is refused and the window stays blank. Pinning
  // both sides to 127.0.0.1 avoids the family mismatch (and matches the loopback
  // RPC server). `--host 127.0.0.1` forces Vite's bind.
  const port = await findFreePort(DEV_PORT_BASE);
  const cdpPort = await findFreePort(CDP_PORT_BASE);
  const devUrl = `http://127.0.0.1:${port}`;
  const vitePhase = session?.phase("vite");
  session?.setDevUrl(devUrl);
  console.log(`[mirin dev] starting Vite dev server on ${devUrl}…`);
  const vite = Bun.spawn(
    [
      "bunx",
      "vite",
      "--clearScreen",
      "false",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: projectDir,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  try {
    await waitForUrl(devUrl, 15_000);
    vitePhase?.ok(devUrl);
  } catch (err) {
    vitePhase?.fail(err instanceof Error ? err.message : String(err));
    vite.kill();
    throw err;
  }

  // --- launch the app ---
  const launchPhase = session?.phase("launch");
  console.log(`[mirin dev] launching ${appName}…`);
  const appProc = Bun.spawn([exe], {
    cwd: projectDir,
    env: {
      ...process.env,
      MIRIN_CORE: IS_WINDOWS
        ? join(app, "mirin_core.dll")
        : IS_LINUX
          ? join(app, "libmirin_core.so")
          : join(app, "Contents", "MacOS", "libmirin_core.dylib"),
      // Linux: the flat app dir holds libcef.so + libmirin_core.so; put it on the
      // loader path so the host's dlopen and libmirin_core's NEEDED libcef.so (and
      // the spawned mirin-helper) all resolve. (macOS uses the framework loader;
      // Windows the exe-dir search — neither needs this.)
      ...(IS_LINUX
        ? {
            LD_LIBRARY_PATH: `${app}${process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : ""}`,
          }
        : {}),
      MIRIN_WORKER: workerJs,
      MIRIN_DEV_URL: devUrl,
      MIRIN_MANIFEST_JSON: JSON.stringify({
        id: bundleId,
        windows: config.windows,
        devtools: config.devtools,
      }),
      // dev: true → enables inspect-element AND gives this run its own `-dev`
      // CEF cache dir, so `mirin dev` can run alongside the installed app.
      // `icon_path` (Linux) → the window's `_NET_WM_ICON` (cosmic dock/taskbar).
      MIRIN_CONFIG_JSON: JSON.stringify({
        dev: true,
        ...(linuxIconPng ? { icon_path: linuxIconPng } : {}),
      }),
      MIRIN_SIDECAR_DIR: sidecarsDir,
      MIRIN_WORKERS_DIR: workersDir,
      // CEF's DevTools-protocol port, which the devtools use for screenshots,
      // accessibility snapshots, page evaluation, and synthetic input. Loopback
      // only, and only ever set for a dev run (docs/agent-devtools.md).
      MIRIN_CDP_PORT: String(cdpPort),
      ...(session?.env() ?? {}),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  session?.setPid(appProc.pid);
  launchPhase?.ok();
  if (session) {
    console.log(`[mirin dev] dev session: ${session.paths.dir}`);
    // The app publishes its inspector endpoint once the Worker binds it; report it
    // when it lands, without holding up the dev loop if it never does.
    void session.waitForInspector().then((endpoint) => {
      if (endpoint === undefined) return;
      console.log(
        `[mirin dev] inspector: http://127.0.0.1:${endpoint.port} — token in inspector.json`,
      );
    });
  }

  const cleanup = () => {
    vite.kill();
    appProc.kill();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await appProc.exited;
  vite.kill();
  // Post-mortem for whoever (or whatever) reads the session afterwards.
  session?.finish(code, appProc.signalCode ?? undefined);
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
