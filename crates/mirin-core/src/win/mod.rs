//! Windows (Win32) native layer. Mirrors `mac/`: one concern per submodule
//! (AGENTS.md); the engine and FFI talk to the re-exports here.
//!
//! Unlike macOS — where CEF paints into a mirin-owned NSView and the embedded-view
//! close lifecycle needs the detach dance — CEF on Windows renders *windowed*: it
//! creates and owns a child HWND parented to the mirin-owned top-level window built
//! in `window.rs`, and closing follows CEF's standard path (WM_CLOSE →
//! CloseBrowser → on_before_close).

pub mod clipboard;
pub mod dialog;
pub mod gpu;
pub mod menu;
pub mod osr;
pub mod shortcut;
pub mod tray;
pub mod window;

pub use window::{
    acquire_single_instance, activate_existing_instance, close_all_windows, close_window, control,
    create_window, is_remote_session, mark_window_closing, maybe_start_drag,
    resize_browser_to_client, set_app_id, set_dpi_awareness, set_draggable_regions, set_position,
    set_window_title, window_id_for_cef_handle, window_id_for_hwnd, DragRegion, TitleBarStyle,
    WindowParams,
};
