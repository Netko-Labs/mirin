//! Off-screen rendering (OSR) view for transparent windows. CEF renders into a
//! BGRA buffer; this module owns the AppKit view, input forwarding, material
//! container, and paint upload.

mod input;
mod material;
mod paint;
mod state;
mod view;

pub use material::{install, set_material, MaterialOpts};
pub use paint::paint;

pub fn remove(window_id: u32) {
    state::remove(window_id);
}

/// Logical view size for CEF's view_rect.
pub fn view_size(window_id: u32) -> Option<(i32, i32)> {
    state::view_size(window_id)
}

pub fn scale(window_id: u32) -> Option<f32> {
    crate::mac::window::backing_scale(window_id)
}
