# forks

Upstream crates mirin owns a fork of. Each one is a real fork with git
history, not a copied-in snapshot: the `forks-upstream` branch holds the
crates exactly as published (minus `examples/`, `Cargo.lock`,
`Cargo.toml.orig`, and packaging metadata), and mirin's changes sit on top of
it in the main history. Each fork's `MIRIN.md` lists every change and why;
changed code carries a `// mirin:` comment.

| Fork | Upstream | Used by |
| --- | --- | --- |
| `gpui` | `gpui` 0.2.2 (Zed Industries, Apache-2.0) | `crates/mirin-metal` |
| `taffy` | `taffy` 0.9.0 (DioxusLabs, MIT), the version GPUI pins | `forks/gpui` |
| `blade-graphics` | `blade-graphics` 0.7.1 (Dzmitry Malyshau, MIT), the version GPUI pins | `forks/gpui` |
| `accesskit_unix` | `accesskit_unix` 0.24.1 (AccessKit, MIT OR Apache-2.0) | `crates/mirin-metal` |
| `accesskit_atspi_common` | `accesskit_atspi_common` 0.21.1 (AccessKit, MIT OR Apache-2.0), the version `accesskit_unix` pins | `forks/accesskit_unix` |
| `accesskit_consumer` | `accesskit_consumer` 0.39.2 (AccessKit, MIT OR Apache-2.0), the version `accesskit_atspi_common` pins | `forks/accesskit_atspi_common`, `crates/mirin-metal`'s tests |
| `zed` | the GPUI crates of the zed repository at `f8cfc7ed` (2026-11-10; Zed Industries, every crate Apache-2.0) | `crates/mirin-metal/next` (the build on upstream GPUI) |
| `taffy-next` | `taffy` 0.15.0 (DioxusLabs, MIT), the version upstream GPUI pins | `forks/zed` |
| `wgpu` | `wgpu-hal` of the wgpu repository at `cddb2f5d` (gfx-rs, MIT OR Apache-2.0), the commit upstream GPUI pins | `forks/zed` (`gpui_wgpu`, through wgpu) |
| `gpu-allocator` | `gpu-allocator` 0.28.0 (Traverse Research, MIT OR Apache-2.0), the version wgpu-hal pins | `forks/wgpu` |

`crates/mirin-metal/Cargo.toml` points `[patch.crates-io]` here (`gpui`,
`taffy`, `blade-graphics`, `accesskit_unix`, `accesskit_atspi_common`,
`accesskit_consumer`); `crates/mirin-metal/next/Cargo.toml`
builds the same sources on `zed` and `taffy-next` instead (and the same
AccessKit forks), with `wgpu-hal` and `gpu-allocator` patched to `wgpu` and
`gpu-allocator` here
(`docs/metal/gpui-next.md`). The forks are
excluded from the root Cargo workspace; each builds alone with mirin-metal's
lockfile (`forks/gpui/MIRIN.md`).

## Syncing upstream

Upstream updates are a merge, so git carries mirin's changes forward and only
real conflicts need hands:

```sh
git worktree add ../forks-upstream forks-upstream
cd ../forks-upstream
# replace forks/<name> with the new release, dropping examples/, Cargo.lock,
# Cargo.toml.orig and packaging metadata, then:
git add -A forks/<name> && git commit -m "chore(forks): <name> <version> upstream"
cd - && git merge forks-upstream    # resolve conflicts against MIRIN.md
```

Then update the fork's `MIRIN.md` (version, changes that upstream absorbed)
and run its tests and mirin-metal's.

## `zed/`: GPUI from the zed repository

`zed/` mirrors the zed repository's layout, pruned to what a build resolves:
the root `Cargo.toml` (the crates inherit their edition, dependencies and
lints from it; cargo reads it for a path dependency and does not load the
other members it lists), `LICENSE-APACHE`, `rust-toolchain.toml`, and
`crates/<name>` for the 20 crates mirin-metal's build resolves on any target
(`gpui`, `gpui_platform`, `gpui_linux`, `gpui_wgpu`, `gpui_macos`,
`gpui_windows`, `gpui_web`, `gpui_ios`, `gpui_apple`, `gpui_macros`,
`gpui_util`, `gpui_shared_string`, `collections`, `refineable` with
`derive_refineable`, `sum_tree`, `scheduler`, `http_client`, `ztracing`,
`ztracing_macro`, `bench_metrics`), each without `examples/`. Every one is
`Apache-2.0` in its manifest (`license = "Apache-2.0"`, its `LICENSE-APACHE`
a link to the root's); none of zed's GPL crates is imported. Changed files
say so with `// mirin:` comments and rows in `zed/MIRIN.md`, as Apache-2.0
asks.

Re-sync to a newer zed commit (a stable release's, about monthly):

```sh
git worktree add ../forks-upstream-next forks-upstream-next
cd ../forks-upstream-next
REV=<zed commit>
git clone --filter=blob:none --no-checkout https://github.com/zed-industries/zed /tmp/zed
git -C /tmp/zed archive "$REV" Cargo.toml LICENSE-APACHE rust-toolchain.toml \
    $(for c in <the crates above>; do echo crates/$c; done) | (rm -rf forks/zed && mkdir forks/zed && tar -x -C forks/zed)
find forks/zed -type d -name examples -prune -exec rm -rf {} +
git add -A forks/zed && git commit -m "chore(forks): zed GPUI crates at <rev>"
cd - && git merge forks-upstream-next    # resolve conflicts against zed/MIRIN.md
```

If the new commit pins another taffy, replace `taffy-next/` the same way.
Then check that `cargo metadata` in `crates/mirin-metal/next` lists no
crate from `forks/zed` that is missing (a new dependency of GPUI's means one
more `crates/<name>`), refresh `crates/mirin-metal/next/Cargo.lock` from the
new commit's `Cargo.lock` for the versions upstream tests, repeat any new
`[patch.crates-io]` entries of zed's root manifest in the next manifest
(a workspace's patches do not reach a dependent outside it), and run the
checks in `zed/MIRIN.md`.
