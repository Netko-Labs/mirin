use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
    MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSColor, NSGlassEffectView, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::ffi::c_void;

use super::state;
use super::view::{new_view, MirinOsrView};
use crate::mac::window;

/// Default panel corner radius (points) when a material doesn't specify one.
const DEFAULT_CORNER_RADIUS: f64 = 14.0;
const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
const NS_VIEW_HEIGHT_SIZABLE: u64 = 16;

/// Native background material rendered behind the web UI of a transparent window.
/// The AppKit half of `mirin/config`'s `material` option.
#[derive(Clone)]
pub struct MaterialOpts {
    /// "liquidGlass" | a vibrancy name (sidebar/menu/popover/hud/...) | "none".
    pub kind: String,
    /// Optional Liquid Glass tint, sRGB rgba in 0..1.
    pub tint: Option<[f64; 4]>,
    /// Corner radius in points.
    pub corner_radius: f64,
}

impl MaterialOpts {
    fn is_none(&self) -> bool {
        self.kind.is_empty() || self.kind == "none"
    }
}

/// Create the OSR view for `window_id`, install it (optionally behind a native
/// material) as the window's content view, and return its NSView pointer (used
/// as the windowless parent). Main thread only.
pub fn install(
    mtm: MainThreadMarker,
    window_id: u32,
    width: f64,
    height: f64,
    material: Option<MaterialOpts>,
) -> *mut c_void {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
    let view = new_view(mtm, window_id, frame);

    let scale = window::backing_scale(window_id).unwrap_or(2.0) as f64;
    // With no material, the OSR view rounds itself so its corners show the
    // desktop. With a material, the glass/vibrancy container provides the rounded
    // surface and the OSR view fills it edge to edge.
    let radius = corner_radius(material.as_ref());
    let round_view = material.as_ref().map(MaterialOpts::is_none).unwrap_or(true);
    unsafe {
        let _: () = msg_send![&view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![&view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setOpaque: false];
            let _: () = msg_send![layer, setContentsScale: scale];
            if round_view {
                let _: () = msg_send![layer, setCornerRadius: radius];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        }
        let _: () =
            msg_send![&view, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
    }

    apply_material(mtm, window_id, &view, material.as_ref(), frame);

    let ptr = Retained::as_ptr(&view) as *mut c_void;
    state::insert(window_id, view);
    ptr
}

/// Swap the background material of a live OSR window, re-parenting its existing
/// OSR view into a fresh container. Main thread only.
pub fn set_material(mtm: MainThreadMarker, window_id: u32, material: Option<MaterialOpts>) {
    let Some(view) = state::get(window_id) else {
        return;
    };
    let frame = view.frame();
    unsafe {
        let _: () = msg_send![&view, removeFromSuperview];
        // Re-round the OSR view only when nothing backs it.
        let round_view = material.as_ref().map(MaterialOpts::is_none).unwrap_or(true);
        let layer: *mut AnyObject = msg_send![&view, layer];
        if !layer.is_null() {
            if round_view {
                let _: () = msg_send![layer, setCornerRadius: corner_radius(material.as_ref())];
                let _: () = msg_send![layer, setMasksToBounds: true];
            } else {
                let _: () = msg_send![layer, setCornerRadius: 0.0_f64];
                let _: () = msg_send![layer, setMasksToBounds: false];
            }
        }
    }
    apply_material(mtm, window_id, &view, material.as_ref(), frame);
}

fn corner_radius(material: Option<&MaterialOpts>) -> f64 {
    material
        .map(|m| m.corner_radius)
        .unwrap_or(DEFAULT_CORNER_RADIUS)
}

/// Whether AppKit's Liquid Glass (NSGlassEffectView, macOS 26+) is available.
fn glass_available() -> bool {
    AnyClass::get(c"NSGlassEffectView").is_some()
}

/// Build the window's content view for `osr_view`: a Liquid Glass or vibrancy
/// container behind it, or the OSR view directly when there's no material.
fn apply_material(
    mtm: MainThreadMarker,
    window_id: u32,
    osr_view: &MirinOsrView,
    material: Option<&MaterialOpts>,
    frame: NSRect,
) {
    let content: &NSView = osr_view;
    match material {
        // No material: the OSR view is the content view directly. No event:
        // nothing was requested.
        None => window::set_content_view(window_id, content, content),
        // Explicit "none" (e.g. setMaterial(null)): clear the material and report it.
        Some(m) if m.is_none() => {
            window::set_content_view(window_id, content, content);
            emit_material_event(window_id, &m.kind, "none");
        }

        // Liquid Glass: the OSR view becomes the glass's content view, so the
        // glass renders behind it and clips it to the glass corner radius.
        Some(m) if m.kind == "liquidGlass" && glass_available() => {
            let glass: Retained<NSGlassEffectView> =
                unsafe { msg_send![NSGlassEffectView::alloc(mtm), initWithFrame: frame] };
            glass.setCornerRadius(m.corner_radius);
            if let Some([r, g, b, a]) = m.tint {
                let color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a);
                glass.setTintColor(Some(&color));
            }
            unsafe {
                let _: () = msg_send![&glass, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
            }
            glass.setContentView(Some(content));
            window::set_content_view(window_id, &glass, content);
            emit_material_event(window_id, &m.kind, "liquidGlass");
        }

        // Vibrancy via NSVisualEffectView, also the Liquid Glass fallback on
        // macOS < 26. The OSR view sits on top of the blurred material.
        Some(m) => {
            let kind = if m.kind == "liquidGlass" {
                "hud"
            } else {
                m.kind.as_str()
            };
            let fx: Retained<NSVisualEffectView> =
                unsafe { msg_send![NSVisualEffectView::alloc(mtm), initWithFrame: frame] };
            fx.setMaterial(visual_effect_material(kind));
            fx.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            fx.setState(NSVisualEffectState::Active);
            unsafe {
                let _: () = msg_send![&fx, setWantsLayer: true];
                let layer: *mut AnyObject = msg_send![&fx, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setCornerRadius: m.corner_radius];
                    let _: () = msg_send![layer, setMasksToBounds: true];
                }
                let _: () = msg_send![&fx, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
                let _: () = msg_send![&fx, addSubview: content];
            }
            window::set_content_view(window_id, &fx, content);
            emit_material_event(window_id, &m.kind, "vibrancy");
        }
    }
}

/// Tell the worker which material backend was actually used.
fn emit_material_event(window_id: u32, requested: &str, backend: &str) {
    crate::engine::emit_event(&material_event_json(
        window_id,
        requested,
        backend,
        glass_available(),
    ));
}

/// Build the `window.material` event JSON. `requested` is the app-supplied
/// `material.type` string, so it must be escaped — serde_json handles quotes and
/// backslashes that a hand-rolled `format!` would turn into invalid JSON.
fn material_event_json(window_id: u32, requested: &str, backend: &str, available: bool) -> String {
    serde_json::json!({
        "type": "window.material",
        "id": window_id,
        "requested": requested,
        "backend": backend,
        "liquidGlassAvailable": available,
    })
    .to_string()
}

/// Map a vibrancy material name to NSVisualEffectMaterial.
fn visual_effect_material(name: &str) -> NSVisualEffectMaterial {
    match name {
        "sidebar" => NSVisualEffectMaterial::Sidebar,
        "menu" => NSVisualEffectMaterial::Menu,
        "popover" => NSVisualEffectMaterial::Popover,
        "hud" | "hudWindow" => NSVisualEffectMaterial::HUDWindow,
        "fullScreenUI" => NSVisualEffectMaterial::FullScreenUI,
        "underWindowBackground" => NSVisualEffectMaterial::UnderWindowBackground,
        "contentBackground" => NSVisualEffectMaterial::ContentBackground,
        "windowBackground" => NSVisualEffectMaterial::WindowBackground,
        "titlebar" => NSVisualEffectMaterial::Titlebar,
        "selection" => NSVisualEffectMaterial::Selection,
        "headerView" => NSVisualEffectMaterial::HeaderView,
        "sheet" => NSVisualEffectMaterial::Sheet,
        "toolTip" => NSVisualEffectMaterial::ToolTip,
        _ => NSVisualEffectMaterial::HUDWindow,
    }
}

#[cfg(test)]
mod tests {
    use super::material_event_json;

    #[test]
    fn material_event_escapes_special_chars() {
        // A `material.type` with a quote/backslash must not break the Worker's
        // JSON.parse — the payload has to stay valid JSON.
        let json = material_event_json(7, r#"a"b\c"#, "vibrancy", true);
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["type"], "window.material");
        assert_eq!(value["id"], 7);
        assert_eq!(value["requested"], r#"a"b\c"#);
        assert_eq!(value["backend"], "vibrancy");
        assert_eq!(value["liquidGlassAvailable"], true);
    }
}
