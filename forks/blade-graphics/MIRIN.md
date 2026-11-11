# mirin's blade-graphics fork

`blade-graphics` 0.7.1 from crates.io (Dzmitry Malyshau, MIT), the version GPUI
0.2.2 pins, forked in the monorepo (`forks/blade-graphics`) so a Metal host
holds the GPU memory it uses. Every change is listed here and marked with a
`// mirin:` comment in the source. The README's two images (`etc/*.png`,
`etc/*.gif`) are left out.

| Change | Files | Why |
| --- | --- | --- |
| The GPU allocator is sized for a desktop app (`gpu_alloc::Config`: 256 KiB or more is a dedicated allocation, smaller ones share chunks that start at 256 KiB) | `src/vulkan/init.rs` | Blade used gpu-alloc's `i_am_prototyping` preset: 8 MiB first chunks, and everything under 32 MiB from a buddy allocator, which rounds a request up to a power of two and takes a chunk of twice that when it grows. A window's 8.2 MiB multisampled target held 32 MiB; the counter demo (800×600) held 70 MiB of GPU memory, which on an integrated GPU is system memory, for the ~20 it used. Now a texture is its own allocation of its own size, freed with it, and only small buffers share chunks: 23.6 MiB for the same window (13.8 with the GPUI fork's path textures made on demand). Upstreamable as a `ContextDesc` option. |
| Two lints newer than the crate are allowed | `src/lib.rs` | A path dependency is built with the workspace's lints, not capped as a registry one is: `mismatched_lifetime_syntaxes` and `deprecated` warned on every build. |

To update: see `../README.md` (merge the `forks-upstream` branch), then
reconcile the changes above.
