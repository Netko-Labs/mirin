# mirin's fork of upstream GPUI

The GPUI crates of the zed repository (Zed Industries, Apache-2.0) at
commit `f8cfc7ed` (`../README.md` says what is here and how to re-sync),
forked in the monorepo so `crates/mirin-metal` can build on upstream GPUI
(`crates/mirin-metal/next/Cargo.toml`) beside the fork of gpui 0.2.2
(`../gpui`) until it replaces it (`docs/metal/gpui-next.md`). Every change is
listed here and marked with a `// mirin:` comment in the source. Rows that
port a change of `../gpui` say which (`../gpui/MIRIN.md`).

| Change | Files | Why |
| --- | --- | --- |
| Explicit grid track lists (`Style::grid_template_columns` / `grid_template_rows`, `GridTrack`, `TrackBreadth`) | `crates/gpui/src/style.rs`, `crates/gpui/src/taffy.rs` | Port of `../gpui`'s row: Tailwind `grid-cols-[16px_1fr]`, `grid-cols-[1fr_auto]`; upstream has only `repeat(N, minmax(_, 1fr))` (`GridTemplate`). A pixel breadth is rounded to device pixels as upstream rounds every length. Upstreamable. |
| `justify_items` / `justify_self` | `crates/gpui/src/style.rs`, `crates/gpui/src/taffy.rs` | Port of `../gpui`'s row: grid inline-axis alignment (`justify-self-end`, `justify-items-center`). Upstreamable. |

To update: see `../README.md` (merge the `forks-upstream-next` branch), then
reconcile the changes above.

Checks: mirin-metal's tests on this fork, `cd crates/mirin-metal/next &&
cargo test --lib` (the shared sources, with `--features gpui-next` by
default), and `cargo clippy --all-targets -- -D warnings` there.
