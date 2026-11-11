# forks (pristine upstream)

This branch (`forks-upstream`) holds the upstream crates mirin forks, byte for
byte as published, minus `examples/`, `Cargo.lock`, `Cargo.toml.orig`, and
packaging metadata. mirin's changes live on top of it in the main history, so
syncing upstream is a git merge of this branch, not a hand re-apply.

`zed/` is the GPUI crates of the zed repository
(<https://github.com/zed-industries/zed>, Apache-2.0) at commit
`f8cfc7ed9e57503def9479138894f3139f5400cc` (main, 2026-11-10), in zed's own
layout: the root `Cargo.toml` (the crates inherit their edition,
dependencies and lints from it), `LICENSE-APACHE`, `rust-toolchain.toml`,
and `crates/<name>` for the 20 crates a build of mirin-metal resolves
(`gpui`, `gpui_platform`, `gpui_linux`, `gpui_wgpu`, `gpui_macos`,
`gpui_windows`, `gpui_web`, `gpui_ios`, `gpui_apple`, `gpui_macros`,
`gpui_util`, `gpui_shared_string`, `collections`, `refineable` with
`derive_refineable`, `sum_tree`, `scheduler`, `http_client`,
`ztracing`, `ztracing_macro`, `bench_metrics`), minus `examples/`.
`taffy-next/` is `taffy` 0.15.0 from crates.io (DioxusLabs, MIT), the
version that GPUI pins.
