//! Glass: a view with `material` (`"thin"`, `"regular"`, `"thick"`,
//! `"paper"`, `"veil"`) is a pane the compositor fills with that material
//! (what is behind the window, blurred, saturated and tinted), rounded at
//! the view's own `cornerRadius`.
//!
//! The view paints its pane in the frame it is drawn in
//! (`Window::paint_glass`), clipped by whatever clips the view, so the
//! platform sends it with that very frame: on Wayland the blur region
//! (`ext-background-effect-v1`) and each pane's radius and material (Dashi's
//! `dashi_glass_v1`) before the commit that shows the frame (sumi-linux's
//! `wayland/glass.rs`). A panel that resizes never shows glass a frame
//! behind its content, as a rect sent from `onLayout` did.
//!
//! While the platform draws glass (`Window::is_glass_available`), the view
//! paints no `background`: the compositor tints. When it does not (another
//! compositor or an older Dashi, where nothing is sent; glass turned off for
//! the app; the first frame, before the compositor said), the view paints
//! its `background` as any view does: the background is the material's
//! fallback. A host that takes `material` says `"glass":true` in
//! its `protocol` line (names `MIRIN_METAL_GLASS`); one from before refuses a
//! tree with it.
//!
//! A material view is never part of a retained subtree (`retain.rs`
//! `pure_view`): a kept drawing would keep no pane. A view that virtualizes
//! its rows (`list.rs`) cannot be glass; put the list inside one.

use serde::Deserialize;
use sumi::{canvas, prelude::*, px, AnyElement, GlassMaterial, ScrollHandle, Window};

use crate::tree::ViewProps;

/// Names the protocol's `glass` in the host binary, for drivers that look.
pub const GLASS_MARKER: &str = "MIRIN_METAL_GLASS";

/// A view's material, as the tree names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Material {
    Thin,
    Regular,
    Thick,
    Paper,
    Veil,
}

impl Material {
    fn glass(self) -> GlassMaterial {
        match self {
            Material::Thin => GlassMaterial::Thin,
            Material::Regular => GlassMaterial::Regular,
            Material::Thick => GlassMaterial::Thick,
            Material::Paper => GlassMaterial::Paper,
            Material::Veil => GlassMaterial::Veil,
        }
    }
}

/// Whether the view paints its own `background`: not when the compositor
/// fills it with its material.
pub(crate) fn paints_background(props: &ViewProps, window: &Window) -> bool {
    props.material.is_none() || !window.is_glass_available()
}

/// The view's border widths, top, right, bottom, left (`render.rs` draws
/// `borderWidth` as 1 or 2, and a side's own width over it).
fn borders(props: &ViewProps) -> [f32; 4] {
    let all = if props.border_width >= 2.0 {
        2.0
    } else if props.border_width >= 1.0 {
        1.0
    } else {
        0.0
    };
    [
        props.border_top,
        props.border_right,
        props.border_bottom,
        props.border_left,
    ]
    .map(|side| side.unwrap_or(all))
}

/// The child that paints the view's pane, when it has a material: out of
/// the flow (so the layout is the same), over the view's whole box, its
/// border included (an absolute child is placed inside the border), and it
/// paints the pane with those bounds as laid out in this frame. A scroll
/// view's children are moved by its offset, this one too, so the offset is
/// taken back out: the pane is the view's own box, not its content's.
pub(crate) fn pane(props: &ViewProps, scroll: Option<ScrollHandle>) -> Option<AnyElement> {
    let material = props.material?.glass();
    let radius = px(props.corner_radius.max(0.0));
    let element = canvas(
        |_, _, _| {},
        move |bounds, (), window, _| {
            let offset = scroll.map(|handle| handle.offset()).unwrap_or_default();
            let bounds = sumi::Bounds {
                origin: bounds.origin - offset,
                size: bounds.size,
            };
            window.paint_glass(bounds, radius, material);
        },
    );
    let [top, right, bottom, left] = borders(props);
    let element = element
        .absolute()
        .top(px(-top))
        .right(px(-right))
        .bottom(px(-bottom))
        .left(px(-left));
    Some(element.into_any_element())
}

#[cfg(test)]
#[path = "glass/tests.rs"]
mod tests;
