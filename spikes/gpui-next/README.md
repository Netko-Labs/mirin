# spike: mirin-metal on current upstream GPUI

A time-boxed spike, not part of any build: `crates/mirin-metal` compiled
against the GPUI crates in the zed repository as of 2026-11-10 (commit
`f8cfc7ed`) instead of mirin's fork of gpui 0.2.2 (`forks/gpui`). It exists to
answer whether and how to move the fork onto upstream; the findings and the
numbers are in [`docs/metal/gpui-next.md`](../../docs/metal/gpui-next.md).

Nothing here changes `crates/mirin-metal`, `forks/`, or any default build.

## What is here

| File | What it is |
| --- | --- |
| `Cargo.toml`, `Cargo.lock` | A standalone package named `mirin-metal` (same lib, same `mirin-metal-host` binary) whose `gpui` is `zed/crates/gpui` by path. The lockfile started as zed's own, so upstream's crates build with the versions upstream tests. |
| `fetch-zed.sh` | Shallow, sparse checkout of zed at the pinned commit into `./zed` (ignored): GPUI's crates and the eight workspace crates they need. Upstream's sources are referenced, not copied. |
| `port.patch` | The whole port: every line of `crates/mirin-metal/src` that differs on upstream GPUI (291 lines added and 122 removed in 21 of its files, of 15,870 lines; 113 of the added are `src/upstream.rs`), `src/upstream.rs` and the test changes included. |
| `prepare.sh` | Writes `./src` and `./examples` (ignored): `crates/mirin-metal` at the commit the port was written against, plus `port.patch`. `--diff` rewrites the patch from an edited `./src`. |
| `frame-ratio.sh` | Medians of `render`, `frame` and their ratio from stress-bench traces: how the doc compares hosts on a loaded machine. |

`src/upstream.rs` (in the patch) holds what the fork has and upstream lacks or
shapes differently: an adapter from the fork's layer-shell options onto
upstream's `WindowKind::LayerShell`, and stand-ins for grid track lists and
retained subtrees. Every changed place is marked `SPIKE`, `SPIKE STUB` (compiles,
does less) or `SPIKE GAP` (feature off).

## Build

Needs Rust 1.98.1 or newer (upstream's `rust-toolchain.toml`), and network once.

```sh
cd spikes/gpui-next
./fetch-zed.sh          # ~20 MB, ~30 s
./prepare.sh
cargo build --release --bin mirin-metal-host    # ~2 min on 16 cores
```

If cargo sits on `Updating git repository https://github.com/gfx-rs/wgpu`
(upstream pins wgpu to a git commit; cargo fetches its whole history), run it
with `CARGO_NET_GIT_FETCH_WITH_CLI=true`.

The host is `target/release/mirin-metal-host`; it speaks the same protocol as
the fork's, so every demo and bench takes it as its host argument:

```sh
cd packages/mirin-metal && bun demo/counter.tsx ../../spikes/gpui-next/target/release/mirin-metal-host
```

`MIRIN_METAL_GPUI_LOG=1` prints GPUI's own log on stderr (which GPU adapter
and backend wgpu chose).

## Reproduce the numbers

Back to back with round 1's host, retention off there (upstream has none), in
a nested compositor (`docs/metal.md`, 5b, "Measuring"):

```sh
N=$PWD/spikes/gpui-next/target/release/mirin-metal-host
R=<round 1 host>   # crates/mirin-metal at 5fbcfb7, cargo build --release --bin mirin-metal-host

cd packages/mirin-metal
MIRIN_METAL_RETAIN=0 bun bench/stress.tsx $R --visible
bun bench/stress.tsx $N --visible

cd ../mirin-metal-ui
MIRIN_METAL_RETAIN=0 bun bench/native.tsx $R --visible
bun bench/native.tsx $N --visible
bun bench/layout-check.tsx grid $R $N --visible      # where the two hosts lay a tree out differently
bun bench/layout-check.tsx browser $R $N --visible
```

`--trace=<path>` on the stress bench writes the host's trace;
`./frame-ratio.sh <trace>...` gives the per-run medians the doc tabulates.

Startup and memory of the counter demo were measured with the footprint
lane's `packages/mirin-metal/bench/footprint.tsx` (branch `perf-footprint`,
commit `4dbca91`): `bun bench/footprint.tsx <host> --app=counter --visible`.
Run every host from a disk, not from `/tmp`: a binary on tmpfs can be swapped
out, which lowers its RSS. The "Vulkan only" column is the spike host built
with `backends: wgpu::Backends::VULKAN` in
`zed/crates/gpui_wgpu/src/wgpu_context.rs` (`WgpuContext::instance`).

The tests: `cargo test --lib` (164 pass; the 5 that fail each need a fork
change upstream lacks, listed in the doc).

## What does not work in the spike host

Listed with sizes in the doc (section 1). In short: no retained subtrees, no
session lock, no unified title bar on Dashi, no file drag-out, no
per-paragraph text sizes, no raising the least size after open, grid track
lists become equal columns, and a layer surface cannot name its screen.
