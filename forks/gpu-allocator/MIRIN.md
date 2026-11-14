# mirin's gpu-allocator fork

`gpu-allocator` 0.28.0 from crates.io (Traverse Research, MIT OR Apache-2.0),
the version wgpu-hal pins, forked in the monorepo (`forks/gpu-allocator`) so a
Metal host holds the GPU memory it uses
(`crates/mirin-metal`, `docs/metal/gpui-next.md`). Every change is listed
here and marked with a `// mirin:` comment in the source. `examples/` is left
out.

| Change | Files | Why |
| --- | --- | --- |
| A shared memory block is a multiple of 256 KiB and at least that (`AllocationSizes::adjust_memblock_size`; upstream: of 4 MiB) | `src/lib.rs` | The allocator shares a block among small resources of one kind of memory, and its least block was 4 MiB. The counter demo (800×600) held three (12 MiB) for 6.5 MiB of resources: one for its buffers, one filled by the glyph atlas, one for 2 KiB of staging buffers. With `../wgpu`'s row and `../zed`'s (a 2 MiB first block, host blocks half of it) it holds 3 MiB. On an integrated GPU that is system memory. Upstreamable (the limit is a default, not an alignment the driver needs). |

To update: see `../README.md` (merge the `forks-upstream` branch), then
reconcile the change above. Its own tests: `cp
../../crates/mirin-metal/Cargo.lock . && cargo test --lib --features
vulkan; rm Cargo.lock`.
