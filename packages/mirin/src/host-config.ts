/**
 * Resolve the single-instance value shared by the native host and Worker.
 * `MIRIN_CONFIG_JSON` is an internal native override, while the manifest is the
 * developer-facing setting; either explicit opt-out must disable automatic apply.
 */
export function resolveHostSingleInstance(
  manifestValue: unknown,
  nativeConfigValue: unknown,
): boolean {
  return manifestValue !== false && nativeConfigValue !== false;
}
