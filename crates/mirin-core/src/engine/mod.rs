//! CEF engine: browser-process boot, app/client handlers, window/browser
//! lifecycle, and the command/event surface the FFI layer exposes to the Bun
//! Worker. Handler structure adapted from cef-rs's cefsimple example
//! (Apache-2.0/MIT), reshaped for mirin-owned windows.

mod boot;
mod commands;
mod config;
mod events;
mod handlers;
mod state;
mod tasks;
mod window;

pub mod clipboard;
pub mod codec;
pub mod dialog;
pub mod menu;
pub mod osr;
pub mod shortcut;
pub mod tray;

pub use boot::run_core;
pub use clipboard::{clipboard_read_text, clipboard_write_text};
pub use commands::{
    close_window, create_window, load_url, quit, request_window_close, set_dock_visible,
    set_material, set_title, window_control, window_maybe_start_drag, window_set_position,
};
pub use config::{CoreConfig, WindowOpts};
pub use dialog::dialog_show;
pub use events::{emit_event, emit_window_event, emit_window_frame, poll_event};
pub use handlers::MirinHandler;
pub use menu::{popup_menu, set_app_menu};
pub use shortcut::{shortcut_register, shortcut_unregister};
pub use state::{icon_path, is_dev, is_ready, set_rpc_endpoint, wm_class};
pub use tray::{tray_create, tray_destroy};
