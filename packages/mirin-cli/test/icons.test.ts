import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { stampMacSdk } from "../src/bundle/macos/index.ts";
import { isIconComposerDoc, writeAppearanceCatalog } from "../src/icons/macos/index.ts";
import {
  currentIconPlatform,
  resolveIconFallback,
  resolveIconSource,
} from "../src/icons/sources.ts";

const temporaryDirectories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirin-icons-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("isIconComposerDoc", () => {
  test("matches only an Icon Composer document", () => {
    expect(isIconComposerDoc("/p/AppIcon.icon")).toBe(true);
    expect(isIconComposerDoc("/p/icon.icns")).toBe(false);
    expect(isIconComposerDoc("/p/icon.iconset")).toBe(false);
    expect(isIconComposerDoc("/p/icon.png")).toBe(false);
  });
});

/**
 * `actool` ships only with a full Xcode, so these assert the real compile where
 * one exists and the documented fallback where it doesn't.
 */
describe("writeAppearanceCatalog", () => {
  const hasActool =
    process.platform === "darwin" &&
    (existsSync("/Applications/Xcode.app/Contents/Developer/usr/bin/actool") ||
      existsSync("/Applications/Xcode-beta.app/Contents/Developer/usr/bin/actool"));

  /** A minimal single-layer Icon Composer document over a square PNG. */
  async function iconDocument(dir: string): Promise<string> {
    const doc = join(dir, "AppIcon.icon");
    mkdirSync(join(doc, "Assets"), { recursive: true });
    const art = join(doc, "Assets", "art.png");
    await $`sips -s format png -z 1024 1024 /System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericApplicationIcon.icns --out ${art}`
      .nothrow()
      .quiet();
    if (!existsSync(art)) throw new Error("could not stage icon fixture art");
    writeFileSync(
      join(doc, "icon.json"),
      JSON.stringify({
        fill: { "automatic-gradient": "extended-srgb:0.50000,0.50000,0.50000,1.00000" },
        groups: [{ layers: [{ "image-name": "art.png", name: "art" }] }],
        "supported-platforms": { squares: ["macOS"] },
      }),
    );
    return doc;
  }

  test.skipIf(!hasActool)(
    "compiles a document into Assets.car",
    async () => {
      const dir = tempDir();
      const resources = join(dir, "Resources");
      mkdirSync(resources, { recursive: true });

      const catalog = await writeAppearanceCatalog(
        await iconDocument(dir),
        resources,
        join(dir, "work"),
      );

      expect(catalog?.name).toBe("AppIcon");
      expect(existsSync(join(resources, "Assets.car"))).toBe(true);
      // actool derives the legacy .icns, which is the only one an .icon can supply.
      expect(catalog?.icns && existsSync(catalog.icns)).toBe(true);
    },
    60_000,
  );

  test.skipIf(!hasActool)(
    "compiles from a relative work directory",
    async () => {
      const dir = tempDir();
      const resources = join(dir, "Resources");
      mkdirSync(resources, { recursive: true });

      // actool resolves its own arguments, so a relative work dir must still land.
      const catalog = await writeAppearanceCatalog(
        await iconDocument(dir),
        resources,
        join(dir, "nested", "work"),
      );

      expect(catalog?.name).toBe("AppIcon");
      expect(existsSync(join(resources, "Assets.car"))).toBe(true);
    },
    60_000,
  );

  test.skipIf(!hasActool)(
    "returns undefined for an unreadable document",
    async () => {
      const dir = tempDir();
      const resources = join(dir, "Resources");
      mkdirSync(resources, { recursive: true });
      const doc = join(dir, "Broken.icon");
      mkdirSync(doc, { recursive: true });
      writeFileSync(join(doc, "icon.json"), "{ not json");

      const catalog = await writeAppearanceCatalog(doc, resources, join(dir, "work"));

      expect(catalog).toBeUndefined();
      expect(existsSync(join(resources, "Assets.car"))).toBe(false);
    },
    60_000,
  );
});

describe("resolveIconSource", () => {
  test("returns undefined when no icon is configured", () => {
    expect(resolveIconSource(undefined, "/project", "macos")).toBeUndefined();
  });

  test("resolves a plain path against the project root on every platform", () => {
    for (const platform of ["macos", "windows", "linux"] as const) {
      expect(resolveIconSource("icon.iconset", "/project", platform)).toBe("/project/icon.iconset");
    }
  });

  test("prefers the platform entry over the default", () => {
    const icon = { default: "icon.iconset", macos: "AppIcon.icon" };
    expect(resolveIconSource(icon, "/project", "macos")).toBe("/project/AppIcon.icon");
  });

  test("falls back to default for platforms with no entry", () => {
    const icon = { default: "icon.iconset", macos: "AppIcon.icon" };
    // Linux and Windows cannot read an .icon, so they must not inherit it.
    expect(resolveIconSource(icon, "/project", "linux")).toBe("/project/icon.iconset");
    expect(resolveIconSource(icon, "/project", "windows")).toBe("/project/icon.iconset");
  });

  test("maps the host platform onto an icon platform", () => {
    expect(currentIconPlatform("darwin")).toBe("macos");
    expect(currentIconPlatform("win32")).toBe("windows");
    expect(currentIconPlatform("linux")).toBe("linux");
    expect(currentIconPlatform("freebsd")).toBe("linux");
  });
});

describe("resolveIconFallback", () => {
  test("is undefined for a plain path — it is its own fallback", () => {
    expect(resolveIconFallback("AppIcon.icon", "/project")).toBeUndefined();
    expect(resolveIconFallback(undefined, "/project")).toBeUndefined();
  });

  test("resolves the default entry behind per-platform sources", () => {
    const icon = { default: "icon.iconset", macos: "AppIcon.icon" };
    expect(resolveIconFallback(icon, "/project")).toBe("/project/icon.iconset");
  });
});

describe("stampMacSdk", () => {
  test.skipIf(process.platform !== "darwin" || !Bun.which("vtool"))(
    "rewrites the host's LC_BUILD_VERSION sdk to 26.0",
    async () => {
      const dir = tempDir();
      const exe = join(dir, "host");
      await $`cp /usr/bin/true ${exe}`.quiet();
      await stampMacSdk(exe);
      const out = (await $`otool -l ${exe}`.quiet()).stdout.toString();
      const sdk = out.match(/LC_BUILD_VERSION[\s\S]*?sdk (\S+)/)?.[1];
      expect(sdk).toBe("26.0");
    },
    30_000,
  );
});
