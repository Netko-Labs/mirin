#!/usr/bin/env bun
/**
 * Materialize the dev .app bundle (docs/architecture.md §5).
 *
 * CEF on macOS requires the .app + helper-apps structure even in development:
 *   Mirin Dev.app/Contents/MacOS/<exe>
 *   Mirin Dev.app/Contents/Frameworks/Chromium Embedded Framework.framework
 *   Mirin Dev.app/Contents/Frameworks/<exe> Helper[ (Type)].app   (x5)
 *
 * Helper bundle names derive from the main executable name — CEF resolves
 * "<exe> Helper (Renderer).app/Contents/MacOS/<exe> Helper (Renderer)".
 *
 * Usage: bun scripts/dev-bundle.ts [--bin m1-smoke] [--release]
 */

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CEF_PATH = process.env.CEF_PATH ?? join(ROOT, "vendor", "cef");
const FRAMEWORK = "Chromium Embedded Framework.framework";

const args = Bun.argv.slice(2);
const release = args.includes("--release");
const binFlag = args.indexOf("--bin");
const BIN = binFlag >= 0 ? args[binFlag + 1]! : "m1-smoke";
const PROFILE = release ? "release" : "debug";

const APP_NAME = "Mirin Dev";
const BUNDLE_ID = "dev.mirin.dev";
const HELPER_TYPES: Array<{ suffix: string; idSuffix: string }> = [
  { suffix: "", idSuffix: "helper" },
  { suffix: " (GPU)", idSuffix: "helper.gpu" },
  { suffix: " (Renderer)", idSuffix: "helper.renderer" },
  { suffix: " (Plugin)", idSuffix: "helper.plugin" },
  { suffix: " (Alerts)", idSuffix: "helper.alerts" },
];

function infoPlist(entries: Record<string, string | boolean | Record<string, string>>): string {
  const value = (v: string | boolean | Record<string, string>): string => {
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (typeof v === "string") return `<string>${v}</string>`;
    const inner = Object.entries(v)
      .map(([k, val]) => `<key>${k}</key><string>${val}</string>`)
      .join("");
    return `<dict>${inner}</dict>`;
  };
  const body = Object.entries(entries)
    .map(([k, v]) => `  <key>${k}</key>\n  ${value(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

if (!existsSync(join(CEF_PATH, FRAMEWORK))) {
  console.error(`CEF framework not found at ${CEF_PATH} — run: bun scripts/fetch-cef.ts`);
  process.exit(1);
}

console.log(`[dev-bundle] building ${BIN} + mirin-helper (${PROFILE})`);
const profileFlag = release ? ["--release"] : [];
await $`cargo build -p mirin-core --bin ${BIN} ${profileFlag}`.cwd(ROOT);
await $`cargo build -p mirin-helper ${profileFlag}`.cwd(ROOT);

const TARGET = join(ROOT, "target", PROFILE);
const OUT = join(ROOT, ".build");
const APP = join(OUT, `${APP_NAME}.app`);
const CONTENTS = join(APP, "Contents");
const FRAMEWORKS = join(CONTENTS, "Frameworks");
const EXE = BIN; // CFBundleExecutable / helper-name stem

console.log(`[dev-bundle] assembling ${APP}`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(join(CONTENTS, "MacOS"), { recursive: true });
mkdirSync(join(CONTENTS, "Resources"), { recursive: true });
mkdirSync(FRAMEWORKS, { recursive: true });

cpSync(join(TARGET, BIN), join(CONTENTS, "MacOS", EXE));
writeFileSync(
  join(CONTENTS, "Info.plist"),
  infoPlist({
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: EXE,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: APP_NAME,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: "0.0.1",
    CFBundleVersion: "0.0.1",
    LSMinimumSystemVersion: "13.0",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
    LSFileQuarantineEnabled: true,
    // Chromium requirement; see CEF macOS docs.
    LSEnvironment: { MallocNanoZone: "0" },
  }),
);

// Symlinks inside the framework must survive the copy (cpSync verbatim mode).
cpSync(join(CEF_PATH, FRAMEWORK), join(FRAMEWORKS, FRAMEWORK), {
  recursive: true,
  verbatimSymlinks: true,
});

for (const { suffix, idSuffix } of HELPER_TYPES) {
  const helperName = `${EXE} Helper${suffix}`;
  const helperApp = join(FRAMEWORKS, `${helperName}.app`);
  mkdirSync(join(helperApp, "Contents", "MacOS"), { recursive: true });
  cpSync(join(TARGET, "mirin-helper"), join(helperApp, "Contents", "MacOS", helperName));
  writeFileSync(
    join(helperApp, "Contents", "Info.plist"),
    infoPlist({
      CFBundleDevelopmentRegion: "en",
      CFBundleDisplayName: helperName,
      CFBundleExecutable: helperName,
      CFBundleIdentifier: `${BUNDLE_ID}.${idSuffix}`,
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleName: helperName,
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: "0.0.1",
      CFBundleVersion: "0.0.1",
      LSMinimumSystemVersion: "13.0",
      LSUIElement: "1" as string,
      NSHighResolutionCapable: true,
      LSEnvironment: { MallocNanoZone: "0" },
    }),
  );
}

// Ad-hoc sign inside-out: framework, then helpers, then the outer app.
console.log("[dev-bundle] codesigning (ad-hoc)");
await $`codesign --force --sign - ${join(FRAMEWORKS, FRAMEWORK)}`.quiet();
for (const { suffix } of HELPER_TYPES) {
  await $`codesign --force --sign - ${join(FRAMEWORKS, `${EXE} Helper${suffix}.app`)}`.quiet();
}
await $`codesign --force --sign - ${APP}`.quiet();

console.log(`[dev-bundle] done: ${APP}`);
