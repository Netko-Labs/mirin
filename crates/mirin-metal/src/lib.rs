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

mod access;
mod caret;
mod check;
mod counters;
mod dots;
mod drag;
mod drive;
mod edges;
mod edit;
mod events;
mod field;
mod focus;
mod follow;
mod fonts;
#[cfg(target_os = "linux")]
pub mod gpu;
mod grid;
mod height;
mod idle;
mod ime;
mod input;
mod layout;
mod list;
mod marks;
mod media;
mod patch;
mod pointer;
mod press;
mod pulse;
mod render;
mod retain;
mod runs;
mod scroll;
mod scrollbar;
mod selection;
mod sim;
mod surface;
mod text_mode;
mod titlebar;
#[cfg(target_os = "linux")]
pub mod toplevels;
pub mod trace;
mod tree;
mod value;
mod window;

pub use access::{ACCESSIBLE_MARKER, APP_NAME_VAR, FIELD_TEXT_MARKER};
pub use check::SETTLE_MARKER;
pub use dots::{DotsProps, DOTS_MARKER};
pub use drive::{run, run_deferred, HostMessage, OPEN_MIN_SIZE_MARKER, RESIDENT_MARKER};
pub use events::{EventKind, Modifiers, NativeUiEvent, PointerPhase};
pub use focus::FOCUS_MARKER;
pub use fonts::{DISPLAY_FONT_MARKER, FONT_WEIGHTS_MARKER};
pub use media::IMAGE_ERROR_MARKER;
pub use patch::{parse_patch, PatchOp, PATCH_MARKER, PATCH_PROTOCOL};
pub use pulse::{Pulse, PULSE_MARKER};
pub use scroll::{ScrollCommand, ScrollPosition, SCROLL_MARKER};
pub use sim::{LayoutNode, SimCommand, ACTIVATION_MARKER};
pub use surface::{parse_surface, Surface, OPAQUE_SURFACE_MARKER};
pub use titlebar::{Chrome, Controls, TitleBar};
pub use tree::{
    parse_tree, Align, Direction, InputProps, InputRun, Justify, NodeSpec, SelectionRange,
    TextProps, ViewProps, Weight,
};
pub use value::REBASE_MARKER;
pub use window::{DriverMessage, NativeUiOptions};
