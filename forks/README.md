# forks

Upstream crates mirin owns a fork of, and sumi, Metal's engine, which began
as one. Each fork is a real fork with git history, not a copied-in snapshot:
the `forks-upstream` branch holds the crates exactly as published (minus
`examples/`, `Cargo.lock`, `Cargo.toml.orig`, and packaging metadata), and
mirin's changes sit on top of it in the main history. Each fork's `MIRIN.md`
lists every change and why; changed code carries a `// mirin:` comment.

| Fork | Upstream | Used by |
| --- | --- | --- |
| `accesskit_unix` | `accesskit_unix` 0.24.1 (AccessKit, MIT OR Apache-2.0) | `crates/mirin-metal` |
| `accesskit_atspi_common` | `accesskit_atspi_common` 0.21.1 (AccessKit, MIT OR Apache-2.0), the version `accesskit_unix` pins | `forks/accesskit_unix` |
| `accesskit_consumer` | `accesskit_consumer` 0.39.2 (AccessKit, MIT OR Apache-2.0), the version `accesskit_atspi_common` pins | `forks/accesskit_atspi_common`, `crates/mirin-metal`'s tests |
| `taffy-next` | `taffy` 0.15.0 (DioxusLabs, MIT), the version sumi pins | `forks/sumi` |
| `wgpu` | `wgpu-hal` of the wgpu repository at `cddb2f5d` (gfx-rs, MIT OR Apache-2.0), the commit sumi pins | `forks/sumi` (`sumi-wgpu`, through wgpu) |
| `gpu-allocator` | `gpu-allocator` 0.28.0 (Traverse Research, MIT OR Apache-2.0), the version wgpu-hal pins | `forks/wgpu` |

`sumi/` is not in the table: it is no longer a fork that syncs (below).

`crates/mirin-metal/Cargo.toml` depends on `sumi`'s crates by path and
points `[patch.crates-io]` at the rest (`taffy` to `taffy-next`, the three
AccessKit crates, `gpu-allocator`, and `wgpu-hal` of the wgpu repository to
`wgpu`). The forks and sumi are excluded from the root Cargo workspace.

Until 2026-11 Metal built on forks of the crates.io release `gpui` 0.2.2,
`taffy` 0.9.0 and `blade-graphics` 0.7.1 instead; they are gone from the
tree and stay in git history (`docs/metal/gpui-next.md` has the move).

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

## `sumi/`: Metal's engine

`sumi/` is mirin Metal's own engine (`sumi/README.md`,
`docs/metal/engine.md`). It was a fork of the GPUI crates of the zed
repository (Zed Industries, every crate `Apache-2.0`), kept under `zed/` and
synced by merge until Zed commit `703b5ac3` (2026-11-14). That was the last
merge: the crates were then moved here, renamed (`gpui` is `sumi`,
`gpui_<x>` is `sumi-<x>`), and cut to what Metal calls. So:

- **Nothing here is synced.** The steps under "Syncing upstream" are for the
  forks in the table, not for sumi. A fix from Zed is picked by hand and
  recorded in `sumi/PICKS.md` (`sumi/README.md`, "Picking from Zed").
- **`forks-upstream-next` is frozen.** That branch holds Zed's crates as
  they were imported, at `703b5ac3`, under `forks/zed/`. It takes no more
  imports; it stays so that a diff against it shows what is sumi's.
- **`sumi/MIRIN.md` is a closed record** of what mirin changed against Zed
  up to the fork point. Changes since are ordinary commits.
- **The license stays Zed's.** Every crate is `Apache-2.0` in its manifest,
  its `LICENSE-APACHE` a link to `sumi/LICENSE-APACHE`; none of zed's GPL
  crates was ever imported. The code derives from Zed's GPUI and is
  modified, which `sumi/README.md` states as Apache-2.0 asks.

`sumi/` keeps the shape a cargo workspace needs: the root `Cargo.toml` (the
crates inherit their edition, dependencies and lints from it; it was zed's
root manifest, cut to what these crates use), `rust-toolchain.toml`, and
`crates/<name>`. If sumi pins another taffy, replace `taffy-next/` as any
fork is synced, and repeat any new `[patch.crates-io]` entry of
`sumi/Cargo.toml` in `crates/mirin-metal/Cargo.toml` (a workspace's patches
do not reach a dependent outside it).
