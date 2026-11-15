#!/usr/bin/env bun

/**
 * A source tarball of mirin Metal's host that builds with no network.
 *
 *   bun scripts/metal-source.ts pack <output-directory> [--version=<version>]
 *   bun scripts/metal-source.ts verify <tarball>
 *
 * `pack` archives what a build of `crates/mirin-metal` reads (the crate, the
 * forks it builds by path, the license) from the commit checked out, vendors
 * every other dependency beside it (`cargo vendor --locked`: crates.io's and
 * the git ones in `Cargo.lock`), writes the `.cargo/config.toml` that points
 * cargo at them, and packs it as `mirin-metal-<version>-source.tar.xz`. It
 * refuses a tree with a `rust-toolchain` file in it: a packager builds with
 * the distribution's Rust, and that file makes rustup download another.
 *
 * `verify` unpacks a tarball and builds the host from it as a packager would:
 * `cargo build --release --locked --offline` in `crates/mirin-metal`, with an
 * empty `CARGO_HOME` (no registry cache, no git checkouts) and
 * `CARGO_NET_OFFLINE=true`; and, where the kernel allows, in a network
 * namespace with no interface at all.
 *
 * The release workflow runs both on a tag and uploads the tarball
 * (`.github/workflows/release.yml`, `metal-source`).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

import {
  cargoConfig,
  isToolchainFile,
  SOURCE_PATHS,
  sourceDirectory,
  tarballName,
} from "./lib/metal-source.ts";

const ROOT = join(import.meta.dir, "..");
const CRATE = join("crates", "mirin-metal");
const USAGE =
  "usage: bun scripts/metal-source.ts pack <output-directory> [--version=<version>]\n" +
  "       bun scripts/metal-source.ts verify <tarball>";

const [command, target, ...rest] = Bun.argv.slice(2);
if (command === "pack" && target) {
  const version = rest.find((arg) => arg.startsWith("--version="))?.slice(10);
  console.log(await pack(resolve(target), version ?? packageVersion()));
} else if (command === "verify" && target) {
  await verify(resolve(target));
} else {
  console.error(USAGE);
  process.exit(2);
}

/** The version a release tag names: the runtime package's. */
function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(ROOT, "packages", "mirin", "package.json"), "utf8"),
  );
  if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
    const { version } = manifest;
    if (typeof version === "string") return version;
  }
  throw new Error("metal-source: packages/mirin/package.json has no version");
}

/** Every file under `directory`, as paths from it. */
function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(join(directory, entry.name), path) : [path];
  });
}

/** Make the tarball in `outputDirectory`; its path. */
async function pack(outputDirectory: string, version: string): Promise<string> {
  const name = sourceDirectory(version);
  const tarball = join(outputDirectory, tarballName(version));
  const stage = mkdtempSync(join(tmpdir(), "mirin-metal-source-"));
  try {
    // Only what the commit holds: no build output, nothing untracked.
    await $`git archive --format=tar --prefix=${`${name}/`} HEAD -- ${SOURCE_PATHS} | tar -x -C ${stage}`.cwd(
      ROOT,
    );
    const tree = join(stage, name);
    const toolchains = filesUnder(tree).filter(isToolchainFile);
    if (toolchains.length > 0) {
      throw new Error(
        `metal-source: ${toolchains.join(", ")} would make a packager's cargo download a toolchain`,
      );
    }
    const crate = join(tree, CRATE);
    const vendored = await $`cargo vendor --locked --versioned-dirs vendor`.cwd(crate).quiet();
    mkdirSync(join(crate, ".cargo"), { recursive: true });
    await Bun.write(join(crate, ".cargo", "config.toml"), cargoConfig(vendored.stdout.toString()));
    await Bun.write(join(tree, "BUILDING.md"), building(version));

    mkdirSync(outputDirectory, { recursive: true });
    rmSync(tarball, { force: true });
    // Files in one order, owned by nobody, dated by the commit.
    const committed = (await $`git log -1 --format=%ct HEAD`.cwd(ROOT).text()).trim();
    await $`tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=${`@${committed}`} -cf - -C ${stage} ${name} | xz -T0 -6 > ${tarball}`;
    return tarball;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** What the tarball says about itself. */
function building(version: string): string {
  return `# mirin Metal ${version}: source for a build with no network

The host (\`mirin-metal-host\`) of mirin Metal, its engine and the forks it
builds by path, and every other dependency in \`crates/mirin-metal/vendor/\`
(the crates.io ones and the git ones of \`Cargo.lock\`). Made by
\`scripts/metal-source.ts\` of the mirin repository at the release's tag.

\`\`\`sh
cd crates/mirin-metal
cargo build --release --locked --offline --bin mirin-metal-host
\`\`\`

\`crates/mirin-metal/.cargo/config.toml\` points cargo at \`vendor/\` and sets
\`net.offline\`, so nothing is fetched and no \`CARGO_HOME\` cache is needed.
No \`rust-toolchain\` file is in the tree: the build takes the Rust on the
\`PATH\` (the engine was written against 1.98; Fedora 44's 1.99 builds it).
\`--no-default-features\` builds the host without Dashi's own Wayland
protocols.

Build dependencies on Linux: a C compiler and \`pkg-config\`, and the
development files of fontconfig, FreeType, Wayland's client library, xcb,
xkbcommon (and its X11 part) and Vulkan's loader.

Licenses: \`LICENSE\` (mirin, MIT); \`forks/*/LICENSE*\` and
\`forks/sumi/NOTICE\` (the engine derives from Zed's GPUI, Apache-2.0); each
vendored crate carries its own.
`;
}

/** Build the host from `tarball` with no way to the network. */
async function verify(tarball: string): Promise<void> {
  if (!statSync(tarball).isFile()) throw new Error(`metal-source: no such tarball: ${tarball}`);
  const work = mkdtempSync(join(tmpdir(), "mirin-metal-verify-"));
  try {
    await $`tar -xJf ${tarball} -C ${work}`;
    const [name] = readdirSync(work);
    if (!name) throw new Error("metal-source: the tarball is empty");
    const tree = join(work, name);
    // A vendored crate's own toolchain file is never read: cargo is not
    // started in its directory, and rustup hands the toolchain it chose to
    // the compilers it starts there.
    const vendor = `${CRATE}/vendor/`;
    const toolchains = filesUnder(tree).filter(
      (path) => isToolchainFile(path) && !path.startsWith(vendor),
    );
    if (toolchains.length > 0) {
      throw new Error(`metal-source: the tarball has ${toolchains.join(", ")}`);
    }
    const cargoHome = join(work, "cargo-home");
    mkdirSync(cargoHome);
    const env = { ...process.env, CARGO_HOME: cargoHome, CARGO_NET_OFFLINE: "true" };
    const crate = join(tree, CRATE);
    const build = [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--offline",
      "--bin",
      "mirin-metal-host",
    ];
    // A network namespace of its own has no interface but a loopback that is
    // down: the strongest "no network" there is, where unprivileged user
    // namespaces are allowed.
    const isolated = (await $`unshare -rn true`.nothrow().quiet()).exitCode === 0;
    console.log(
      isolated
        ? "metal-source: building in a network namespace with no interface"
        : "metal-source: no unprivileged network namespace here; building with CARGO_NET_OFFLINE and an empty CARGO_HOME",
    );
    await $`${isolated ? ["unshare", "-rn", ...build] : build}`.cwd(crate).env(env);
    const host = join(crate, "target", "release", "mirin-metal-host");
    // Cargo makes `registry/` with a tag file in any home; an index, a
    // downloaded crate or a git checkout there would mean it fetched.
    const fetched = filesUnder(cargoHome).filter((path) =>
      /^(registry\/(index|cache|src)|git)\//.test(path),
    );
    if (fetched.length > 0) {
      throw new Error(`metal-source: the build fetched into CARGO_HOME (${fetched[0]}, …)`);
    }
    console.log(`metal-source: built ${name} offline (${statSync(host).size} bytes)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
