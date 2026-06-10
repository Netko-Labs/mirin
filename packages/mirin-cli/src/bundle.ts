/**
 * Assemble a macOS .app bundle for a mirin app (docs/architecture.md §1, §5).
 *
 *   <App>.app/Contents/
 *     MacOS/<exe>                 compiled Bun host
 *     MacOS/libmirin_core.dylib   loaded by the host via bun:ffi
 *     Frameworks/Chromium Embedded Framework.framework
 *     Frameworks/<exe> Helper[ (Type)].app   x5   (mirin-helper)
 *
 * Helper bundle names derive from the main executable name — CEF resolves
 * "<exe> Helper (Renderer).app/Contents/MacOS/<exe> Helper (Renderer)".
 */

import { $ } from "bun";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FRAMEWORK = "Chromium Embedded Framework.framework";

const HELPER_TYPES = [
  { suffix: "", id: "helper" },
  { suffix: " (GPU)", id: "helper.gpu" },
  { suffix: " (Renderer)", id: "helper.renderer" },
  { suffix: " (Plugin)", id: "helper.plugin" },
  { suffix: " (Alerts)", id: "helper.alerts" },
];

export interface BundleOptions {
  appName: string; // also the executable stem; helpers are "<appName> Helper"
  bundleId: string;
  outDir: string;
  hostExe: string; // compiled Bun host binary
  coreDylib: string; // libmirin_core.dylib
  helperBin: string; // compiled mirin-helper binary
  cefPath: string; // dir containing the CEF framework (vendor/cef)
  /** Codesign identity; "-" (default) is ad-hoc. Set to a Developer ID to ship. */
  signIdentity?: string;
  /** Production-only resources placed under Contents/Resources. */
  resources?: {
    uiDir?: string; // Vite dist/, copied to Resources/ui (served via app://ui)
    workerJs?: string; // bundled main-process Worker entry -> Resources/worker.js
    manifestJson?: string; // serialized manifest -> Resources/mirin.manifest.json
  };
}

type PlistValue = string | boolean | Record<string, string>;

function plist(entries: Record<string, PlistValue>): string {
  const render = (v: PlistValue): string => {
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (typeof v === "string") return `<string>${v}</string>`;
    const inner = Object.entries(v)
      .map(([k, val]) => `<key>${k}</key><string>${val}</string>`)
      .join("");
    return `<dict>${inner}</dict>`;
  };
  const body = Object.entries(entries)
    .map(([k, v]) => `  <key>${k}</key>\n  ${render(v)}`)
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

/** Build the .app and return the path to its executable. */
export async function buildAppBundle(opts: BundleOptions): Promise<{ app: string; exe: string }> {
  const { appName, bundleId, cefPath } = opts;
  if (!existsSync(join(cefPath, FRAMEWORK))) {
    throw new Error(`CEF framework not found at ${cefPath} — run: bun scripts/fetch-cef.ts`);
  }

  const app = join(opts.outDir, `${appName}.app`);
  const contents = join(app, "Contents");
  const macos = join(contents, "MacOS");
  const frameworks = join(contents, "Frameworks");

  rmSync(app, { recursive: true, force: true });
  mkdirSync(macos, { recursive: true });
  mkdirSync(frameworks, { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });

  cpSync(opts.hostExe, join(macos, appName));
  cpSync(opts.coreDylib, join(macos, "libmirin_core.dylib"));

  writeFileSync(
    join(contents, "Info.plist"),
    plist({
      CFBundleDevelopmentRegion: "en",
      CFBundleDisplayName: appName,
      CFBundleExecutable: appName,
      CFBundleIdentifier: bundleId,
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleName: appName,
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: "0.0.1",
      CFBundleVersion: "0.0.1",
      LSMinimumSystemVersion: "13.0",
      NSHighResolutionCapable: true,
      NSSupportsAutomaticGraphicsSwitching: true,
      LSFileQuarantineEnabled: true,
      LSEnvironment: { MallocNanoZone: "0" },
    }),
  );

  cpSync(join(cefPath, FRAMEWORK), join(frameworks, FRAMEWORK), {
    recursive: true,
    verbatimSymlinks: true,
  });

  // Production resources: the served UI, the Worker bundle, and the manifest.
  const resources = join(contents, "Resources");
  if (opts.resources?.uiDir) {
    cpSync(opts.resources.uiDir, join(resources, "ui"), { recursive: true });
  }
  if (opts.resources?.workerJs) {
    cpSync(opts.resources.workerJs, join(resources, "worker.js"));
  }
  if (opts.resources?.manifestJson != null) {
    writeFileSync(join(resources, "mirin.manifest.json"), opts.resources.manifestJson);
  }

  for (const { suffix, id } of HELPER_TYPES) {
    const name = `${appName} Helper${suffix}`;
    const helperApp = join(frameworks, `${name}.app`);
    mkdirSync(join(helperApp, "Contents", "MacOS"), { recursive: true });
    cpSync(opts.helperBin, join(helperApp, "Contents", "MacOS", name));
    writeFileSync(
      join(helperApp, "Contents", "Info.plist"),
      plist({
        CFBundleDevelopmentRegion: "en",
        CFBundleDisplayName: name,
        CFBundleExecutable: name,
        CFBundleIdentifier: `${bundleId}.${id}`,
        CFBundleInfoDictionaryVersion: "6.0",
        CFBundleName: name,
        CFBundlePackageType: "APPL",
        CFBundleShortVersionString: "0.0.1",
        CFBundleVersion: "0.0.1",
        LSMinimumSystemVersion: "13.0",
        LSUIElement: "1",
        NSHighResolutionCapable: true,
        LSEnvironment: { MallocNanoZone: "0" },
      }),
    );
  }

  // Sign inside-out: framework, helpers, then the outer app. Ad-hoc ("-") by
  // default; pass a Developer ID to produce a distributable, notarizable app.
  const identity = opts.signIdentity ?? "-";
  await $`codesign --force --sign ${identity} ${join(frameworks, FRAMEWORK)}`.quiet();
  for (const { suffix } of HELPER_TYPES) {
    await $`codesign --force --sign ${identity} ${join(frameworks, `${appName} Helper${suffix}.app`)}`.quiet();
  }
  await $`codesign --force --sign ${identity} ${app}`.quiet();

  return { app, exe: join(macos, appName) };
}
