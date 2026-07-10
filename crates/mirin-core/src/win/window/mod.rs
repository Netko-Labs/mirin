//! mirin-owned top-level Win32 windows. CEF embeds its browser as a child HWND;
//! this facade owns the stable platform surface while implementation concerns
//! live in smaller modules.

mod controls;
mod create;
mod dpi;
mod drag;
mod identity;
mod registry;
mod types;
mod wndproc;

pub use controls::{
    close_all_windows, close_window, control, resize_browser_to_client, set_position,
    set_window_title,
};
pub use create::create_window;
pub use dpi::{is_remote_session, set_dpi_awareness};
pub use drag::{maybe_start_drag, set_draggable_regions};
pub use identity::{acquire_single_instance, activate_existing_instance, set_app_id};
pub use registry::{mark_window_closing, window_id_for_cef_handle, window_id_for_hwnd};
pub use types::{DragRegion, TitleBarStyle, WindowParams};

pub(crate) use registry::hwnd_for;
