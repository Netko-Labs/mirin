/** What `scripts/metal-source.ts` decides without touching the disk. */

/** The paths of the repository a build of `crates/mirin-metal` reads. */
export const SOURCE_PATHS = ["crates/mirin-metal", "forks", "LICENSE"] as const;

/** A release version as the tarball names it: digits and dots, an optional pre-release. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The directory the tarball unpacks into. */
export function sourceDirectory(version: string): string {
  if (!VERSION.test(version)) throw new Error(`metal-source: not a version: ${version}`);
  return `mirin-metal-${version}`;
}

/** The tarball's file name for a version. */
export function tarballName(version: string): string {
  return `${sourceDirectory(version)}-source.tar.xz`;
}

/**
 * Whether a file would make rustup fetch a toolchain for a packager who
 * builds with the distribution's: `rust-toolchain` or `rust-toolchain.toml`,
 * in any directory.
 */
export function isToolchainFile(path: string): boolean {
  const name = path.split("/").pop();
  return name === "rust-toolchain" || name === "rust-toolchain.toml";
}

/**
 * The `.cargo/config.toml` beside `Cargo.toml`: the source replacements
 * `cargo vendor` printed (everything from its first `[source` table), and
 * cargo told not to reach the network at all.
 */
export function cargoConfig(vendorOutput: string): string {
  const start = vendorOutput.indexOf("[source.");
  if (start < 0 || !vendorOutput.includes("[source.vendored-sources]")) {
    throw new Error("metal-source: cargo vendor printed no source replacement");
  }
  const sources = vendorOutput.slice(start).trim();
  return [
    "# Written by scripts/metal-source.ts: every dependency of crates/mirin-metal",
    "# that is not in this tree (crates.io's and the git ones) is in `vendor/`,",
    "# so `cargo build --release --locked` here needs no network.",
    sources,
    "",
    "[net]",
    "offline = true",
    "",
  ].join("\n");
}
