# mirin-native (alpha)

GPU-rendered native UI for mirin apps, built on [GPUI](https://www.gpui.rs) —
Zed's GPU-accelerated Rust UI framework.

## Status

Exploratory **alpha** (`0.1.0-alpha.x`). The crate is deliberately standalone:

- Excluded from the root Cargo workspace (`exclude` in the root `Cargo.toml`),
  so the main CEF build, CI, and release pipeline are unaffected.
- Not wired into the FFI surface (`ffi.rs`), the engine, or the TypeScript
  packages yet.
- Public API is a single `run(NativeUiOptions)` that opens a GPU-rendered
  window with a placeholder root view and blocks in GPUI's event loop.

## Why

CEF gives mirin its web-rendered app windows. Some surfaces (palettes,
launchers, overlays, high-frequency UI) want native GPU rendering without a
Chromium process tree. GPUI is the candidate backend; this crate derisks it the
same way `m1-smoke` derisked CEF: window up, render, clean quit, per platform.

## Run

```sh
cd crates/mirin-native
cargo run --example hello
```

Platform notes:

- macOS: renders via Metal; no extra system deps.
- Linux: needs Vulkan (Mesa is fine) plus the usual XKB/Wayland client libs.
- Windows: renders via DirectX.

## Integration plan (not yet built)

1. Expose window open/close through the existing flat C ABI pattern
   (`mirin_native_*` symbols), events through the polled queue.
2. Decide thread ownership: GPUI, like CEF, wants the process main thread —
   the two cannot both own it, so a native-UI app mode (or subprocess) must be
   chosen and recorded in `docs/architecture.md` before any FFI lands.
3. Typed TS surface in the runtime package behind an `alpha` export.

Public-API and architecture changes go through `docs/api-design.md` /
`docs/architecture.md` sign-off before leaving alpha.
