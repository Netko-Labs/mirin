/**
 * Resolve the manifest's `icon` — a path, or per-platform {@link IconSources} —
 * to the absolute path this build's target platform should use.
 */

import { join } from "node:path";
import type { IconSources } from "mirinjs/config";

export type IconPlatform = "macos" | "windows" | "linux";

export function currentIconPlatform(platform: NodeJS.Platform = process.platform): IconPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

export function resolveIconSource(
  icon: string | IconSources | undefined,
  projectDir: string,
  platform: IconPlatform = currentIconPlatform(),
): string | undefined {
  if (!icon) return undefined;
  const picked = typeof icon === "string" ? icon : (icon[platform] ?? icon.default);
  return picked ? join(projectDir, picked) : undefined;
}
