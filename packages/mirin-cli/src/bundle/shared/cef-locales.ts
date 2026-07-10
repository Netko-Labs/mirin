import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const CEF_LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const MAC_VARIANTS = new Set(["FEMININE", "MASCULINE", "NEUTER"]);

/** Validate and normalize an optional CEF locale allowlist. */
export function normalizeCefLocales(locales: unknown): string[] | undefined {
  if (locales == null) return undefined;
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new Error("[mirin] cef.locales must contain at least one locale.");
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of locales) {
    if (typeof value !== "string" || !CEF_LOCALE.test(value)) {
      throw new Error(`[mirin] invalid CEF locale ${JSON.stringify(value)}.`);
    }
    const locale = value.replaceAll("_", "-");
    const key = locale.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(locale);
    }
  }
  return normalized;
}

/** Copy selected Windows/Linux `locales/<locale>.pak` files, or every locale when unset. */
export function copyFlatCefLocales(
  source: string,
  destination: string,
  locales: string[] | undefined,
): void {
  if (!locales) {
    cpSync(source, destination, { recursive: true });
    return;
  }

  const entries = readdirSync(source, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pak"),
  );
  const byLocale = new Map(
    entries.map((entry) => [localeKey(entry.name.slice(0, -".pak".length)), entry.name]),
  );

  mkdirSync(destination, { recursive: true });
  for (const locale of locales) {
    const file = byLocale.get(localeKey(locale));
    if (!file) throw new Error(`[mirin] CEF locale "${locale}" is not available in ${source}.`);
    cpSync(join(source, file), join(destination, file));
  }
}

/** Remove unselected macOS `.lproj` locale directories from a copied CEF framework. */
export function pruneMacCefLocales(framework: string, locales: string[] | undefined): void {
  if (!locales) return;

  const resources = join(framework, "Resources");
  const localeDirs = readdirSync(resources, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj"))
    .map((entry) => entry.name);
  const available = new Set(localeDirs.map((name) => name.slice(0, -".lproj".length)));
  const keep = new Set<string>();

  for (const locale of locales) {
    const requested = locale.replaceAll("-", "_");
    const language = requested.split("_", 1)[0] ?? requested;
    const root = available.has(requested)
      ? requested
      : available.has(language)
        ? language
        : undefined;
    if (!root) throw new Error(`[mirin] CEF locale "${locale}" is not available in ${resources}.`);

    keep.add(`${root}.lproj`);
    for (const variant of MAC_VARIANTS) {
      const name = `${root}_${variant}.lproj`;
      if (localeDirs.includes(name)) keep.add(name);
    }
  }

  for (const directory of localeDirs) {
    if (!keep.has(directory)) rmSync(join(resources, directory), { recursive: true, force: true });
  }
}

function localeKey(locale: string): string {
  return locale.replaceAll("_", "-").toLowerCase();
}
