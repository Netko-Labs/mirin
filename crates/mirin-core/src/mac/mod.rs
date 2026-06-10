//! macOS AppKit layer. One concern per submodule (AGENTS.md); the engine and
//! FFI talk to the re-exports here.

pub mod app;
pub mod clipboard;
pub mod dialog;
pub mod menu;
pub mod shortcut;
pub mod tray;
pub mod window;

pub use app::{setup_app_delegate, setup_application};
pub use window::{
    add_titlebar_drag, close_all_windows, close_window, create_window, detach_browser_view,
    make_view_autoresizing, set_window_title, window_id_for_view, TitleBarStyle, WindowParams,
};
