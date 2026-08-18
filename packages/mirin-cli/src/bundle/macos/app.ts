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

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { isIconComposerDoc, writeAppearanceCatalog } from "../../icons/macos/index.ts";
import { pruneMacCefLocales } from "../shared/cef-locales.ts";

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
  /** Production CEF locale allowlist. Undefined keeps every locale. */
  cefLocales?: string[];
  /** App version → Info.plist CFBundleShortVersionString/CFBundleVersion. */
  version?: string;
  /**
   * App icon source: a .icns, a .iconset dir, a square .png, or an Icon Composer
   * .icon document (the only form carrying appearance variants). Optional.
   */
  icon?: string;
  /** `.icns`-capable source used when an `.icon` document can't be compiled. */
  iconFallback?: string;
  /** Codesign identity; "-" (default) is ad-hoc. Set to a Developer ID to ship. */
  signIdentity?: string;
  /** Custom URL schemes -> Info.plist CFBundleURLTypes (deep links). */
  urlSchemes?: string[];
  /** Production-only resources placed under Contents/Resources. */
  resources?: {
    uiDir?: string; // Vite dist/, copied to Resources/ui (served via app://ui)
    workerJs?: string; // bundled main-process Worker entry -> Resources/worker.js
    manifestJson?: string; // serialized manifest -> Resources/mirin.manifest.json
    versionJson?: string; // serialized version.json -> Resources/version.json (updater)
    /** Bundled sidecar binaries -> Resources/sidecars/<name> (copied + signed). */
    sidecars?: SidecarBundle[];
    /** Compiled extra-worker JS (name -> abs path) -> Resources/workers/<name>.js. */
    workers?: Record<string, string>;
  };
}

/** A sidecar binary to bundle: logical name, source path, hardened-runtime entitlements. */
export interface SidecarBundle {
  name: string;
  src: string;
  entitlements: string[];
}

/** Short entitlement name -> the full `com.apple.security.cs.*` key. */
const SIDECAR_ENTITLEMENT_KEYS: Record<string, string> = {
  "allow-jit": "com.apple.security.cs.allow-jit",
  "allow-unsigned-executable-memory": "com.apple.security.cs.allow-unsigned-executable-memory",
  "disable-library-validation": "com.apple.security.cs.disable-library-validation",
};

function entitlementsPlist(names: string[]): string {
  const keys = names
    .map((n) => SIDECAR_ENTITLEMENT_KEYS[n])
    .filter(Boolean)
    .map((k) => `  <key>${k}</key><true/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${keys}
</dict>
</plist>
`;
}

/** The 10 standard iconset renditions (point size + @1x/@2x pixel size). */
const ICONSET_RENDITIONS = [
  { name: "icon_16x16.png", px: 16 },
  { name: "icon_16x16@2x.png", px: 32 },
  { name: "icon_32x32.png", px: 32 },
  { name: "icon_32x32@2x.png", px: 64 },
  { name: "icon_128x128.png", px: 128 },
  { name: "icon_128x128@2x.png", px: 256 },
  { name: "icon_256x256.png", px: 256 },
  { name: "icon_256x256@2x.png", px: 512 },
  { name: "icon_512x512.png", px: 512 },
  { name: "icon_512x512@2x.png", px: 1024 },
];

/** Render one icon source to `Resources/icon.icns`. */
async function writeIcns(iconSrc: string, icns: string, resources: string): Promise<void> {
  if (iconSrc.endsWith(".icns")) {
    cpSync(iconSrc, icns);
  } else if (iconSrc.endsWith(".iconset")) {
    await $`iconutil -c icns ${iconSrc} -o ${icns}`.quiet();
  } else {
    const iconset = join(resources, "icon.iconset");
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset, { recursive: true });
    for (const { name, px } of ICONSET_RENDITIONS) {
      await $`sips -z ${px} ${px} ${iconSrc} --out ${join(iconset, name)}`.quiet();
    }
    await $`iconutil -c icns ${iconset} -o ${icns}`.quiet();
    rmSync(iconset, { recursive: true, force: true });
  }
}

/** The Info.plist keys an icon contributes, empty when there's no usable source. */
interface IconKeys {
  /** CFBundleIconFile — `Resources/icon.icns`, read by macOS 25 and earlier. */
  iconFile?: string;
  /** CFBundleIconName — `Resources/Assets.car`, preferred on macOS 26+. */
  iconName?: string;
}

/**
 * Render the app icon into Resources. An `.icon` document compiles to an
 * `Assets.car` (macOS 26+ light/dark/tinted) and contributes the `.icns` actool
 * derives from it; every other source takes the plain iconutil path.
 */
async function writeIcon(
  iconSrc: string,
  resources: string,
  work: string,
  fallback?: string,
): Promise<IconKeys> {
  if (!existsSync(iconSrc)) {
    console.warn(`[mirin] icon not found, skipping: ${iconSrc}`);
    return {};
  }

  const icns = join(resources, "icon.icns");
  if (isIconComposerDoc(iconSrc)) {
    // An Icon Composer document can't go through iconutil, so the .icns comes
    // from actool — or, when no installed Xcode can compile the document, from
    // the fallback source. A bundle must never ship iconless.
    const catalog = await writeAppearanceCatalog(iconSrc, resources, work);
    if (catalog?.icns) {
      cpSync(catalog.icns, icns);
    } else if (fallback && existsSync(fallback)) {
      console.warn(`[mirin] falling back to ${fallback} for the macOS icon.`);
      await writeIcns(fallback, icns, resources);
    }
    return { iconFile: existsSync(icns) ? "icon" : undefined, iconName: catalog?.name };
  }

  await writeIcns(iconSrc, icns, resources);
  return { iconFile: "icon" };
}

type PlistValue = string | boolean | PlistValue[] | { [k: string]: PlistValue };

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(entries: Record<string, PlistValue>): string {
  const render = (v: PlistValue): string => {
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (typeof v === "string") return `<string>${xmlEscape(v)}</string>`;
    if (Array.isArray(v)) return `<array>${v.map(render).join("")}</array>`;
    const inner = Object.entries(v)
      .map(([k, val]) => `<key>${k}</key>${render(val)}`)
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

  // Render the icon (if any) into Resources before writing the plist, so we
  // only set the icon keys when an icon was actually produced.
  const iconWork = join(opts.outDir, ".mirin-icon");
  const { iconFile, iconName } = opts.icon
    ? await writeIcon(opts.icon, join(contents, "Resources"), iconWork, opts.iconFallback)
    : ({} as IconKeys);
  rmSync(iconWork, { recursive: true, force: true });
  const version = opts.version ?? "0.0.1";

  const info: Record<string, PlistValue> = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: appName,
    CFBundleExecutable: appName,
    CFBundleIdentifier: bundleId,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: appName,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: "13.0",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
    LSFileQuarantineEnabled: true,
    LSEnvironment: { MallocNanoZone: "0" },
  };
  if (iconFile) info.CFBundleIconFile = iconFile;
  // macOS 26+ resolves the appearance-aware icon out of Assets.car via this key
  // and falls back to CFBundleIconFile when the catalog has no match.
  if (iconName) info.CFBundleIconName = iconName;
  // Deep-link schemes: register this app as the macOS handler for app://-style
  // URLs (e.g. anko://…). Delivered at runtime via app.on("open-url").
  if (opts.urlSchemes?.length) {
    info.CFBundleURLTypes = [{ CFBundleURLName: bundleId, CFBundleURLSchemes: opts.urlSchemes }];
  }

  writeFileSync(join(contents, "Info.plist"), plist(info));

  const bundledFramework = join(frameworks, FRAMEWORK);
  cpSync(join(cefPath, FRAMEWORK), bundledFramework, {
    recursive: true,
    verbatimSymlinks: true,
  });
  pruneMacCefLocales(bundledFramework, opts.cefLocales);

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
  // version.json is the running app's self-knowledge for the updater. Written
  // before the codesign loop below so the signature covers it.
  if (opts.resources?.versionJson != null) {
    writeFileSync(join(resources, "version.json"), opts.resources.versionJson);
  }
  // Extra Bun Worker bundles -> Resources/workers/<name>.js (resolveWorker()).
  if (opts.resources?.workers && Object.keys(opts.resources.workers).length) {
    const workersDir = join(resources, "workers");
    mkdirSync(workersDir, { recursive: true });
    for (const [name, src] of Object.entries(opts.resources.workers)) {
      cpSync(src, join(workersDir, `${name}.js`));
    }
  }
  // Sidecar binaries -> Resources/sidecars/<name> (chmod +x; signed below). Paths
  // collected here so the codesign loop can sign them inside-out with the app.
  const sidecarDests: SidecarBundle[] = [];
  if (opts.resources?.sidecars?.length) {
    const sidecarsDir = join(resources, "sidecars");
    mkdirSync(sidecarsDir, { recursive: true });
    for (const sc of opts.resources.sidecars) {
      if (!existsSync(sc.src)) throw new Error(`sidecar "${sc.name}" not found: ${sc.src}`);
      const dest = join(sidecarsDir, sc.name);
      cpSync(sc.src, dest);
      chmodSync(dest, 0o755);
      sidecarDests.push({ name: sc.name, src: dest, entitlements: sc.entitlements });
    }
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
        CFBundleShortVersionString: version,
        CFBundleVersion: version,
        LSMinimumSystemVersion: "13.0",
        LSUIElement: "1",
        NSHighResolutionCapable: true,
        LSEnvironment: { MallocNanoZone: "0" },
      }),
    );
  }

  // Sign inside-out. Ad-hoc ("-") by default for local builds; pass a Developer
  // ID to produce a distributable, notarizable app. Notarization requires the
  // hardened runtime (--options runtime), a secure timestamp (--timestamp), and
  // entitlements that let CEF + Bun JIT and load unsigned executable memory —
  // without all three the Apple notary service returns "Invalid".
  const identity = opts.signIdentity ?? "-";
  const notarizable = identity !== "-";
  const cef = join(frameworks, FRAMEWORK);

  if (notarizable) {
    // Mirrors the entitlement set Electrobun ships for Bun + CEF under hardened
    // runtime (electrobun-reference/package/src/cli/index.ts).
    const entitlements = join(opts.outDir, "_entitlements.plist");
    writeFileSync(
      entitlements,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
`,
    );
    const sign = (path: string, ents = false) =>
      ents
        ? $`codesign --force --timestamp --options runtime --entitlements ${entitlements} --sign ${identity} ${path}`.quiet()
        : $`codesign --force --timestamp --options runtime --sign ${identity} ${path}`.quiet();

    // 1. CEF's nested libraries, then 2. the framework bundle itself.
    const cefLibs = join(cef, "Libraries");
    if (existsSync(cefLibs)) {
      for (const lib of readdirSync(cefLibs)) {
        if (lib.endsWith(".dylib")) await sign(join(cefLibs, lib));
      }
    }
    await sign(cef);
    // 3. our FFI core dylib.
    await sign(join(macos, "libmirin_core.dylib"));
    // 3b. sidecars: hardened runtime + timestamp; per-binary entitlements only
    //     when the spec asks (most CLIs need none — over-entitling is a smell).
    for (const sc of sidecarDests) {
      if (sc.entitlements.length) {
        const ent = join(opts.outDir, `_sidecar_${sc.name}.plist`);
        writeFileSync(ent, entitlementsPlist(sc.entitlements));
        await $`codesign --force --timestamp --options runtime --entitlements ${ent} --sign ${identity} ${sc.src}`.quiet();
        rmSync(ent, { force: true });
      } else {
        await sign(sc.src);
      }
    }
    // 4. each helper: the inner executable, then the .app wrapper (entitlements
    //    on both — the renderer/GPU helpers are what actually JIT).
    for (const { suffix } of HELPER_TYPES) {
      const name = `${appName} Helper${suffix}`;
      const helperApp = join(frameworks, `${name}.app`);
      await sign(join(helperApp, "Contents", "MacOS", name), true);
      await sign(helperApp, true);
    }
    // 5. finally the outer app.
    await sign(app, true);
    rmSync(entitlements, { force: true });
  } else {
    // Ad-hoc: enough to launch locally; not distributable or notarizable.
    await $`codesign --force --sign ${identity} ${cef}`.quiet();
    for (const sc of sidecarDests) {
      await $`codesign --force --sign ${identity} ${sc.src}`.quiet();
    }
    for (const { suffix } of HELPER_TYPES) {
      await $`codesign --force --sign ${identity} ${join(frameworks, `${appName} Helper${suffix}.app`)}`.quiet();
    }
    await $`codesign --force --sign ${identity} ${app}`.quiet();
  }

  return { app, exe: join(macos, appName) };
}
