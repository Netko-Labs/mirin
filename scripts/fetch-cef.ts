#!/usr/bin/env bun
/**
 * Fetch the CEF binary distribution into vendor/cef (docs/architecture.md §5).
 *
 * Wraps cef-rs's `export-cef-dir` tool, pinned to the same version as the
 * `cef` crate in Cargo.toml so the binaries match cef-dll-sys's expectations
 * (its build.rs validates vendor/cef/archive.json and re-downloads on drift).
 *
 * Usage: bun scripts/fetch-cef.ts [--force]
 */

import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CEF_DIR = join(ROOT, "vendor", "cef");
const force = Bun.argv.includes("--force");

const manifest = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const pinned = manifest.match(/^cef\s*=\s*"([^"]+)"/m)?.[1];
if (!pinned) {
  console.error("could not find the `cef` version pin in Cargo.toml");
  process.exit(1);
}

if (!force && existsSync(join(CEF_DIR, "archive.json"))) {
  console.log(`[fetch-cef] vendor/cef already present (use --force to refresh)`);
  process.exit(0);
}

console.log(`[fetch-cef] installing export-cef-dir@${pinned}`);
await $`cargo install export-cef-dir --version ${pinned} --locked`;

// `cargo install` puts export-cef-dir on PATH (the cargo bin dir), so invoke it
// by name rather than guessing `~/.cargo/bin` — CARGO_HOME varies (e.g. scoop-
// managed rustup on Windows) and the binary is `.exe` there. `export-cef-dir`
// auto-selects the distribution for the host target (windows64 / macosarm64 / …).
console.log(`[fetch-cef] downloading CEF into ${CEF_DIR}`);
await $`export-cef-dir --force ${CEF_DIR}`;

console.log("[fetch-cef] done");
