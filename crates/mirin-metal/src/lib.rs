//! mirin-metal (alpha): a React Native-like solution for mirin, built on
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

mod edges;
mod events;
#[cfg(target_os = "linux")]
pub mod gpu;
mod grid;
mod input;
mod list;
mod media;
mod pointer;
mod render;
mod sim;
mod surface;
#[cfg(target_os = "linux")]
pub mod toplevels;
pub mod trace;
mod tree;
mod window;

pub use events::{EventKind, NativeUiEvent, PointerPhase};
pub use sim::{LayoutNode, SimCommand};
pub use surface::parse_surface;
pub use tree::{
    parse_tree, Align, Direction, InputProps, Justify, NodeSpec, TextProps, ViewProps, Weight,
};
pub use window::{run, DriverMessage, NativeUiOptions};
