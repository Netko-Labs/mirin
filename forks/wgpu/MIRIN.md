# mirin's wgpu-hal fork

`wgpu-hal` as it is in the wgpu repository (gfx-rs, MIT OR Apache-2.0) at
commit `cddb2f5d80dc0009b2ef6767635140cacf90a007`, the commit zed's GPUI pins
(`../zed/Cargo.toml`), forked in the monorepo so a Metal host
holds the GPU memory it uses (`crates/mirin-metal`,
`docs/metal/gpui-next.md`). Only `wgpu-hal` is here, in the repository's
layout: `Cargo.toml` is the repository's root manifest (the crate inherits its
version, edition and dependencies from it; cargo reads it for a path
dependency and does not load the members it lists), with its licenses, and
`wgpu-hal/` is the crate, without `examples/`. wgpu, wgpu-core, wgpu-types and
naga stay the repository's own. Every change is listed here and marked with a
`mirin:` comment in the source.

| Change | Files | Why |
| --- | --- | --- |
| The crates of the repository that wgpu-hal depends on (`naga`, `naga-types`, `wgpu-naga-bridge`, `wgpu-sync`, `wgpu-types`) are git dependencies at the fork's commit, and the root's `[patch.crates-io]` of `wgpu` is gone | `Cargo.toml` | They were path dependencies on crates that are not in this fork. From the repository at the same commit they are the same packages wgpu-core and GPUI resolve, so there is one of each in the build. |
| A command encoder allocates one command buffer at a time (`ALLOCATION_GRANULARITY`: 1; upstream: 16) | `wgpu-hal/src/vulkan/command.rs` | radv gives every command buffer an 80 KiB buffer of GPU memory when it is allocated, and wgpu-core keeps a pool per encoder it has opened (a frame's, the queue's pending writes, more while frames are in flight). The counter demo held 100 command buffers (7.8 MiB) after two frames where it had recorded into 16; the default build's renderer holds 6. Now 16 (1.3 MiB); the encoder's free list still reuses them, so a frame allocates none once it has what it records into. Measured on the stress bench: no change in frame time (`docs/metal/gpui-next.md`). Upstreamable as a device option. |
| The least shared memory block is 256 KiB (`AllocationSizes::from_memory_hints`, `MemoryHints::Manual`; upstream: 4 MiB) | `wgpu-hal/src/lib.rs` | With `../gpu-allocator`'s row: GPUI asks for a 2 MiB first block (`../zed`'s row), which upstream raised to 4 MiB, and host blocks half of it, raised the same. |

To re-sync (when zed's GPUI pins another wgpu commit): on the import branch,
replace `forks/wgpu/Cargo.toml`, the licenses and `forks/wgpu/wgpu-hal` with
the repository's at that commit (without `wgpu-hal/examples`), merge, and
reconcile the changes above; the commit in `Cargo.toml`'s git dependencies and
in `crates/mirin-metal/Cargo.toml`'s patch moves with it.

Checks: wgpu-hal's own tests do not run from here (the root manifest names
workspace members that are not imported, as `../zed`'s does); mirin-metal's
`cargo build`, `cargo test --lib` and `cargo clippy --all-targets --
-D warnings` in `crates/mirin-metal` build it, and the benches run on
it.
