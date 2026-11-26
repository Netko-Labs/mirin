//! Glass: the parts of a window the compositor fills with a material (what
//! is behind, blurred and tinted) instead of the window's own pixels.
//!
//! An element paints a pane with [`Window::paint_glass`](crate::Window::paint_glass)
//! while it paints; the panes go into the frame's [`Scene`](crate::Scene),
//! so the platform hands them to the compositor with the very frame that
//! draws them (on Wayland, `ext-background-effect-v1` and Dashi's
//! `dashi_glass_v1`, before the commit that presents it). A window whose
//! platform cannot ([`Window::is_glass_available`](crate::Window::is_glass_available)
//! is false) paints its own fill instead, and its panes go nowhere.

use crate::{Bounds, Pixels};

/// A material, as Dashi's Frost names them; the compositor owns the look of
/// each (its blur, saturation, tint and grain).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GlassMaterial {
    /// The bar, the Dock.
    Thin,
    /// Menus, Control Center, the launcher, banners, sheets.
    Regular,
    /// The focused window's sidebar.
    Thick,
    /// Widgets.
    Paper,
    /// The lock screen's band of frosted wallpaper.
    Veil,
}

impl GlassMaterial {
    /// The material named `name` (`"thin"`, `"regular"`, …).
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "thin" => Self::Thin,
            "regular" => Self::Regular,
            "thick" => Self::Thick,
            "paper" => Self::Paper,
            "veil" => Self::Veil,
            _ => return None,
        })
    }
}

/// One pane of glass in a frame: where it shows in the window (logical
/// pixels, already clipped by whatever clips the element that painted it),
/// its whole shape (its corners are where the element's are, even where a
/// scrolled list cuts it), how round its corners are, and its material.
/// Panes are kept in paint order, back to front.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlassPane {
    /// What of it shows, in window coordinates.
    pub bounds: Bounds<Pixels>,
    /// The whole pane, unclipped, in window coordinates: `bounds` is the
    /// part of it that shows. A platform that can cut a pane draws this
    /// shape inside `bounds`, so a clipped pane is cut straight instead of
    /// rounded again at the clip.
    pub shape: Bounds<Pixels>,
    /// The radius of all four corners.
    pub corner_radius: Pixels,
    /// What it is made of.
    pub material: GlassMaterial,
}
