import { expect, test } from "bun:test";

import { cargoConfig, isToolchainFile, sourceDirectory, tarballName } from "../lib/metal-source.ts";

test("the tarball and its directory are named for the version", () => {
  expect(sourceDirectory("0.9.0")).toBe("mirin-metal-0.9.0");
  expect(tarballName("0.9.0")).toBe("mirin-metal-0.9.0-source.tar.xz");
  expect(tarballName("1.0.0-rc.2")).toBe("mirin-metal-1.0.0-rc.2-source.tar.xz");
});

test("a version that is not one is refused, a path in it above all", () => {
  for (const version of ["", "v0.9.0", "0.9", "0.9.0/..", "../0.9.0", "0.9.0 x"]) {
    expect(() => tarballName(version)).toThrow();
  }
});

test("a toolchain file is found wherever it is", () => {
  expect(isToolchainFile("rust-toolchain.toml")).toBe(true);
  expect(isToolchainFile("forks/sumi/rust-toolchain.toml")).toBe(true);
  expect(isToolchainFile("forks/wgpu/rust-toolchain")).toBe(true);
  expect(isToolchainFile("forks/sumi/Cargo.toml")).toBe(false);
  expect(isToolchainFile("docs/rust-toolchain.toml.md")).toBe(false);
});

test("the cargo config is what cargo vendor printed, and offline", () => {
  const printed = [
    "To use vendored sources, add this to your .cargo/config.toml for this project:",
    "",
    "[source.crates-io]",
    'replace-with = "vendored-sources"',
    "",
    '[source."git+https://github.com/gfx-rs/wgpu?rev=cddb2f5"]',
    'git = "https://github.com/gfx-rs/wgpu"',
    'rev = "cddb2f5"',
    'replace-with = "vendored-sources"',
    "",
    "[source.vendored-sources]",
    'directory = "vendor"',
    "",
  ].join("\n");
  const config = cargoConfig(printed);
  expect(config).not.toContain("To use vendored sources");
  expect(config).toContain('[source.crates-io]\nreplace-with = "vendored-sources"');
  expect(config).toContain('[source."git+https://github.com/gfx-rs/wgpu?rev=cddb2f5"]');
  expect(config).toContain('[source.vendored-sources]\ndirectory = "vendor"');
  expect(config.endsWith("[net]\noffline = true\n")).toBe(true);
});

test("output without a replacement is not a config", () => {
  expect(() => cargoConfig("")).toThrow();
  expect(() => cargoConfig("[source.crates-io]\n")).toThrow();
});
