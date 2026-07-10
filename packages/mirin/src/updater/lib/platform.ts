export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MAC = process.platform === "darwin";

export function platformName(): "darwin" | "linux" | "win32" {
  if (IS_WINDOWS) return "win32";
  if (IS_LINUX) return "linux";
  return "darwin";
}

/** Single-quote a path for safe interpolation into a /bin/sh script. */
export function sh(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a path for safe interpolation into a PowerShell command. */
export function psq(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}
