pub use gpui::layer_shell::*;

use wayland_protocols_wlr::layer_shell::v1::client::{zwlr_layer_shell_v1, zwlr_layer_surface_v1};

pub(crate) fn wayland_layer(layer: Layer) -> zwlr_layer_shell_v1::Layer {
    match layer {
        Layer::Background => zwlr_layer_shell_v1::Layer::Background,
        Layer::Bottom => zwlr_layer_shell_v1::Layer::Bottom,
        Layer::Top => zwlr_layer_shell_v1::Layer::Top,
        Layer::Overlay => zwlr_layer_shell_v1::Layer::Overlay,
    }
}

pub(crate) fn wayland_anchor(anchor: Anchor) -> zwlr_layer_surface_v1::Anchor {
    zwlr_layer_surface_v1::Anchor::from_bits_truncate(anchor.bits())
}

pub(crate) fn wayland_keyboard_interactivity(
    value: KeyboardInteractivity,
) -> zwlr_layer_surface_v1::KeyboardInteractivity {
    match value {
        KeyboardInteractivity::None => zwlr_layer_surface_v1::KeyboardInteractivity::None,
        KeyboardInteractivity::Exclusive => zwlr_layer_surface_v1::KeyboardInteractivity::Exclusive,
        KeyboardInteractivity::OnDemand => zwlr_layer_surface_v1::KeyboardInteractivity::OnDemand,
    }
}

// mirin: a layer surface anchored to both opposite edges stretches along that
// axis (`Anchor`'s own docs say so), which wlr-layer-shell does only when the
// size asked along it is 0; a width or height asked there keeps the surface
// that size, centered, and no longer following the screen's.
/// The size a layer surface asks for (logical pixels): 0 along an axis
/// anchored to both edges, at least 1 along the others.
pub(crate) fn request_size(anchor: Anchor, width: i32, height: i32) -> (u32, u32) {
    let along = |both: Anchor, length: i32| {
        if anchor.contains(both) {
            0
        } else {
            length.max(1) as u32
        }
    };
    (
        along(Anchor::LEFT | Anchor::RIGHT, width),
        along(Anchor::TOP | Anchor::BOTTOM, height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layer_surface_stretches_along_an_axis_anchored_at_both_ends() {
        let bar = Anchor::TOP | Anchor::LEFT | Anchor::RIGHT;
        assert_eq!(request_size(bar, 1280, 28), (0, 28));
        let side = Anchor::LEFT | Anchor::TOP | Anchor::BOTTOM;
        assert_eq!(request_size(side, 64, 900), (64, 0));
        assert_eq!(request_size(Anchor::all(), 10, 10), (0, 0));
        assert_eq!(request_size(Anchor::BOTTOM, 0, 48), (1, 48));
    }
}
