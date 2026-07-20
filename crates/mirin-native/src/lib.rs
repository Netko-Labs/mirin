//! mirin-native (alpha): GPU-rendered native UI for mirin apps, built on
//! [GPUI](https://www.gpui.rs) — Zed's GPU-accelerated Rust UI framework.
//!
//! Status: exploratory alpha. This crate is standalone (excluded from the root
//! workspace) and is not yet wired into the CEF runtime, the FFI surface, or
//! the TypeScript packages. It proves out GPUI as a native-UI backend: open a
//! GPU-rendered window with a mirin-styled root view and a clean quit path.
//! See `README.md` for scope and the integration plan.

mod window;

pub use window::{run, NativeUiOptions};
