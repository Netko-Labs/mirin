/**
 * Off-screen display for checks and benchmarks: a virtual KWin compositor
 * (`kwin_wayland --virtual`) on its own Wayland socket. Hosts spawned with
 * its `env` open their windows there, so nothing appears on (or takes input
 * from) the user's desktop.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface HeadlessDisplay {
  /** Environment for `spawnNativeHost({ env })`: points Wayland clients at the virtual display. */
  env: Record<string, string>;
  /** Stop the compositor. */
  close(): void;
}

export interface HeadlessDisplayOptions {
  width?: number;
  height?: number;
}

let counter = 0;

const MESA_EGL = "/usr/share/glvnd/egl_vendor.d/50_mesa.json";

/**
 * Prefer Mesa's EGL for the virtual compositor. With libglvnd, NVIDIA's vendor
 * library sorts first, so on hybrid laptops the virtual display would
 * composite on the discrete GPU while real sessions usually use the
 * integrated one; apps follow the compositor's GPU (see the host's gpu.rs).
 */
function compositorEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  if (!env.__EGL_VENDOR_LIBRARY_FILENAMES && existsSync(MESA_EGL)) {
    env.__EGL_VENDOR_LIBRARY_FILENAMES = MESA_EGL;
  }
  return env;
}

/**
 * Start a virtual Wayland display, or return null when no supported
 * compositor is installed (callers may fall back to the real display).
 */
export async function startHeadlessDisplay(
  options: HeadlessDisplayOptions = {},
): Promise<HeadlessDisplay | null> {
  const kwin = Bun.which("kwin_wayland");
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!kwin || !runtimeDir) return null;
  counter += 1;
  const socket = `mirin-metal-${process.pid}-${counter}`;
  const child = Bun.spawn(
    [
      kwin,
      "--virtual",
      "--socket",
      socket,
      "--width",
      String(Math.round(options.width ?? 1280)),
      "--height",
      String(Math.round(options.height ?? 800)),
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: compositorEnv() },
  );
  const path = join(runtimeDir, socket);
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill();
      return null;
    }
    await Bun.sleep(50);
  }
  // The compositor holds nothing worth a graceful shutdown, and a plain
  // SIGTERM can leave it running if this process exits right after.
  const stop = () => child.kill("SIGKILL");
  process.once("exit", stop);
  return {
    // An empty DISPLAY keeps GPUI from falling back to the user's X server.
    env: { WAYLAND_DISPLAY: socket, DISPLAY: "" },
    close() {
      process.off("exit", stop);
      stop();
    },
  };
}
