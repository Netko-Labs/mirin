//! mirin-owned NSWindows. This facade keeps the platform surface stable while
//! the implementation is split by concern.

mod controls;
mod create;
mod drag;
mod lifecycle;
mod state;
mod traffic_lights;
mod types;

pub use controls::{
    backing_scale, control, detach_browser_view, make_view_autoresizing, set_content_view,
    set_window_title,
};
pub use create::create_window;
pub use drag::{add_titlebar_drag, set_draggable_regions};
pub use lifecycle::{
    close_all_windows, close_window, discard_window, frame_of, is_zoomed, set_position,
};
pub use state::window_id_for_view;
pub use traffic_lights::set_traffic_light_position;
pub use types::{DragRegion, TitleBarStyle, WindowParams};
