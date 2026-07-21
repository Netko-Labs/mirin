//! mirin-native (alpha): a React Native-like solution for mirin, built on
//! [GPUI](https://www.gpui.rs) — the GPU-accelerated Rust UI framework from
//! the creators of Zed.
//!
//! The model mirrors React Native: a driver (eventually the React reconciler
//! running in mirin's Bun Worker, over FFI) owns state and describes the UI as
//! a serialized element tree; this crate renders that tree with native
//! GPU-drawn elements — no webview — applies streamed tree updates, and
//! reports interaction events back to the driver.
//!
//! Status: exploratory alpha. Standalone (excluded from the root workspace),
//! not yet wired into the CEF runtime, the FFI surface, or the TypeScript
//! packages. See `README.md` for scope and the integration plan.

mod events;
mod render;
mod tree;
mod window;

pub use events::{EventKind, NativeUiEvent};
pub use tree::{parse_tree, Direction, NodeSpec, TextProps, ViewProps};
pub use window::{run, NativeUiOptions};
