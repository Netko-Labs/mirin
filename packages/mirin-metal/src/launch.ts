/**
 * How a Metal app's driver should be started. The driver is the app's own
 * Bun process (its React), and two things about it are decided before its
 * first line runs, so only whatever starts it can set them:
 *
 * - `NODE_ENV=production`: Bun leaves it unset, and React then runs its
 *   development build (the example browser's first render takes twice the
 *   time and CPU, and 10 MB more).
 * - `BUN_JSC_numberOfGCMarkers=1`: JavaScriptCore marks a collection on one
 *   thread instead of eight. For half a minute after an app last did
 *   something, Bun collects once a second, and each collection wakes the
 *   seven helper threads; a UI's heap is small enough for one.
 *
 * A launcher spawns apps with `driverEnv()` as their environment; an app
 * started by hand goes through `mirin-metal run app.tsx` (`cli.ts`).
 */

export interface DriverEnvOptions {
  /** Keep React's development build (its warnings, at its cost). */
  development?: boolean;
}

/**
 * `base` (this process's environment by default) with what a driver should
 * start with. A variable `base` already sets is kept as it is.
 */
export function driverEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
  options: DriverEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  env.NODE_ENV ??= options.development ? "development" : "production";
  env.BUN_JSC_numberOfGCMarkers ??= "1";
  return env;
}
