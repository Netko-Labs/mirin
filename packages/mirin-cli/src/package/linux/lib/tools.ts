import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve an external tool path: an explicit `$ENV` override (if it exists), then
 * PATH, then the first existing `fallback`. Throws a clear, actionable error when
 * none resolve (no user-specific absolute path is baked into committed code).
 */
function resolveTool(bin: string, envVar: string, fallbacks: string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = Bun.which(bin);
  if (onPath) return onPath;
  for (const f of fallbacks) if (existsSync(f)) return f;
  throw new Error(
    `[mirin] "${bin}" not found — install it and put it on PATH, or set $${envVar} ` +
      "to its absolute path.",
  );
}

/** `~/.local/share/gem/ruby/<ver>/bin` (RubyGems user install dir), if resolvable. */
function gemUserBin(): string | undefined {
  const ruby = Bun.which("ruby");
  if (!ruby) return undefined;
  try {
    const dir = Bun.spawnSync([ruby, "-e", "print Gem.user_dir"]).stdout.toString().trim();
    return dir ? join(dir, "bin") : undefined;
  } catch {
    return undefined;
  }
}

export function resolveFpm(): string {
  const fallbacks: string[] = [];
  const gemBin = gemUserBin();
  if (gemBin) fallbacks.push(join(gemBin, "fpm"));
  return resolveTool("fpm", "MIRIN_FPM", fallbacks);
}

export function resolveAppimagetool(): string {
  return resolveTool("appimagetool", "MIRIN_APPIMAGETOOL", [
    join(homedir(), ".local", "bin", "appimagetool"),
  ]);
}
