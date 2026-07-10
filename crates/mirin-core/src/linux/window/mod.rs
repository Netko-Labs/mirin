//! Linux (X11/Ozone) windowing via the CEF **Views** framework. This facade
//! keeps the platform surface stable while the implementation is split by
//! concern: Views delegates, registry, controls, drag/X11, and app identity.

mod controls;
mod drag;
mod icons;
mod state;
mod views;
mod x11;

pub use controls::{close_all_windows, close_window, control, set_position, set_window_title};
pub use drag::{maybe_start_drag, set_draggable_regions};
pub use state::register_window;
pub use views::{
    tag_browser_view, window_id_for_browser, MirinBrowserViewDelegate, MirinWindowDelegate,
};
