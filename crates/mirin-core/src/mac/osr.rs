//! Off-screen rendering (OSR) view for transparent windows. CEF renders the
//! page into a BGRA buffer (no native browser window); we draw it into a
//! transparent, layer-backed NSView and forward input back to CEF. This is the
//! only way to get a genuinely see-through CEF surface (windowed browsers are
//! opaque by API contract).
//!
//! engine::osr drives the CEF side (render handler + input dispatch); this
//! module owns the AppKit view.

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, NSObjectProtocol},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSColor, NSEvent, NSGlassEffectView, NSView, NSVisualEffectBlendingMode,
    NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
};
use objc2_core_foundation::{CFData, CFRetained};
use objc2_core_graphics::{
    CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage,
    CGImageByteOrderInfo,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;

use crate::mac::window;

thread_local! {
    static OSR_VIEWS: RefCell<HashMap<u32, Retained<MirinOsrView>>> = RefCell::new(HashMap::new());
}

/// Per-keystroke event type codes shared with engine::osr (CefKeyEventType).
const KEY_RAWKEYDOWN: i32 = 0;
const KEY_KEYUP: i32 = 2;
const KEY_CHAR: i32 = 3;

/// Mouse button codes shared with engine::osr (0=left, 1=right, 2=middle).
const BUTTON_LEFT: i32 = 0;
const BUTTON_RIGHT: i32 = 1;

#[derive(Default)]
pub struct MirinOsrViewIvars {
    window_id: Cell<u32>,
}

define_class!(
    /// Transparent, flipped, first-responder view that displays CEF's painted
    /// buffer and forwards input. Flipped so its coordinate origin (top-left)
    /// matches CEF's.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MirinOsrViewIvars]
    pub struct MirinOsrView;

    unsafe impl NSObjectProtocol for MirinOsrView {}

    impl MirinOsrView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(mouseDown:))]
        unsafe fn mouse_down(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_LEFT, false);
        }
        #[unsafe(method(mouseUp:))]
        unsafe fn mouse_up(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_LEFT, true);
        }
        #[unsafe(method(rightMouseDown:))]
        unsafe fn right_mouse_down(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_RIGHT, false);
        }
        #[unsafe(method(rightMouseUp:))]
        unsafe fn right_mouse_up(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_RIGHT, true);
        }
        #[unsafe(method(mouseDragged:))]
        unsafe fn mouse_dragged(&self, event: &NSEvent) {
            self.mouse_move(event);
        }
        #[unsafe(method(mouseMoved:))]
        unsafe fn mouse_moved(&self, event: &NSEvent) {
            self.mouse_move(event);
        }
        #[unsafe(method(scrollWheel:))]
        unsafe fn scroll_wheel(&self, event: &NSEvent) {
            let (x, y) = self.point(event);
            let dx = event.scrollingDeltaX() as i32;
            let dy = event.scrollingDeltaY() as i32;
            crate::engine::osr::mouse_wheel(self.window_id(), x, y, dx, dy, modifiers(event));
        }
        #[unsafe(method(keyDown:))]
        unsafe fn key_down(&self, event: &NSEvent) {
            self.key(event, KEY_RAWKEYDOWN);
            // Follow with a CHAR event carrying the typed character.
            if let Some(ch) = first_char(event) {
                let id = self.window_id();
                let (vk, native) = key_codes(event);
                crate::engine::osr::key(id, KEY_CHAR, modifiers(event), vk, native, ch, ch);
            }
        }
        #[unsafe(method(keyUp:))]
        unsafe fn key_up(&self, event: &NSEvent) {
            self.key(event, KEY_KEYUP);
        }
    }
);

impl MirinOsrView {
    fn window_id(&self) -> u32 {
        self.ivars().window_id.get()
    }

    /// Convert an event's location to flipped view coordinates (top-left, points).
    fn point(&self, event: &NSEvent) -> (i32, i32) {
        let loc = event.locationInWindow();
        let p: NSPoint =
            unsafe { msg_send![self, convertPoint: loc, fromView: std::ptr::null::<NSView>()] };
        (p.x as i32, p.y as i32)
    }

    /// Forward a mouse button press/release. `up` distinguishes release from press.
    fn mouse(&self, event: &NSEvent, button: i32, up: bool) {
        let (x, y) = self.point(event);
        let count = event.clickCount() as i32;
        crate::engine::osr::mouse_click(
            self.window_id(),
            x,
            y,
            modifiers(event),
            button,
            up,
            count,
        );
    }

    fn mouse_move(&self, event: &NSEvent) {
        let (x, y) = self.point(event);
        crate::engine::osr::mouse_move(self.window_id(), x, y, modifiers(event), false);
    }

    fn key(&self, event: &NSEvent, type_code: i32) {
        let (vk, native) = key_codes(event);
        crate::engine::osr::key(
            self.window_id(),
            type_code,
            modifiers(event),
            vk,
            native,
            0,
            0,
        );
    }
}

fn modifiers(event: &NSEvent) -> u32 {
    let flags = event.modifierFlags().0;
    let mut m = 0u32;
    const SHIFT: usize = 1 << 17;
    const CONTROL: usize = 1 << 18;
    const OPTION: usize = 1 << 19;
    const COMMAND: usize = 1 << 20;
    if flags & SHIFT != 0 {
        m |= 2; // EVENTFLAG_SHIFT_DOWN
    }
    if flags & CONTROL != 0 {
        m |= 4; // EVENTFLAG_CONTROL_DOWN
    }
    if flags & OPTION != 0 {
        m |= 8; // EVENTFLAG_ALT_DOWN
    }
    if flags & COMMAND != 0 {
        m |= 128; // EVENTFLAG_COMMAND_DOWN
    }
    m
}

fn first_char(event: &NSEvent) -> Option<u16> {
    let chars = event.characters()?;
    chars.to_string().encode_utf16().next()
}

/// (windows_key_code, native_key_code) for a key event.
fn key_codes(event: &NSEvent) -> (i32, i32) {
    let native = event.keyCode() as i32;
    let vk = match native {
        36 => 0x0D,  // Return
        48 => 0x09,  // Tab
        49 => 0x20,  // Space
        51 => 0x08,  // Backspace
        53 => 0x1B,  // Escape
        123 => 0x25, // Left
        124 => 0x27, // Right
        125 => 0x28, // Down
        126 => 0x26, // Up
        _ => first_char(event)
            .map(|c| (c as u8).to_ascii_uppercase() as i32)
            .unwrap_or(0),
    };
    (vk, native)
}

/// Default panel corner radius (points) when a material doesn't specify one.
const DEFAULT_CORNER_RADIUS: f64 = 14.0;
const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
const NS_VIEW_HEIGHT_SIZABLE: u64 = 16;

/// Native background material rendered behind the web UI of a transparent window.
/// The AppKit half of `mirin/config`'s `material` option.
#[derive(Clone)]
pub struct MaterialOpts {
    /// "liquidGlass" | a vibrancy name (sidebar/menu/popover/hud/…) | "none".
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
    let view: Retained<MirinOsrView> = {
        let this = MirinOsrView::alloc(mtm).set_ivars(MirinOsrViewIvars {
            window_id: Cell::new(window_id),
        });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    };

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
    OSR_VIEWS.with(|m| m.borrow_mut().insert(window_id, view));
    ptr
}

/// Swap the background material of a live OSR window, re-parenting its existing
/// OSR view into a fresh container. Main thread only.
pub fn set_material(mtm: MainThreadMarker, window_id: u32, material: Option<MaterialOpts>) {
    let Some(view) = OSR_VIEWS.with(|m| m.borrow().get(&window_id).cloned()) else {
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
        // No material: the OSR view is the content view directly. No event —
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

        // Vibrancy via NSVisualEffectView — also the Liquid Glass fallback on
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

/// Tell the worker which material backend was actually used. `requested` is the
/// asked-for kind; `backend` is "liquidGlass" | "vibrancy" | "none". This is how
/// an app learns whether Liquid Glass (macOS 26+) was applied or fell back.
fn emit_material_event(window_id: u32, requested: &str, backend: &str) {
    crate::engine::emit_event(&format!(
        r#"{{"type":"window.material","id":{window_id},"requested":"{requested}","backend":"{backend}","liquidGlassAvailable":{available}}}"#,
        available = glass_available(),
    ));
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

pub fn remove(window_id: u32) {
    OSR_VIEWS.with(|m| {
        m.borrow_mut().remove(&window_id);
    });
}

/// Logical view size for CEF's view_rect.
pub fn view_size(window_id: u32) -> Option<(i32, i32)> {
    OSR_VIEWS.with(|m| {
        m.borrow().get(&window_id).map(|v| {
            let b = v.bounds();
            (b.size.width as i32, b.size.height as i32)
        })
    })
}

pub fn scale(window_id: u32) -> Option<f32> {
    window::backing_scale(window_id)
}

/// Paint CEF's BGRA buffer (physical pixels) into the view's layer. Main thread.
///
/// # Safety
/// `buffer` must point to `width * height * 4` readable BGRA bytes for the
/// duration of the call (CEF upholds this for the `on_paint` buffer).
pub unsafe fn paint(window_id: u32, buffer: *const u8, width: i32, height: i32) {
    if buffer.is_null() || width <= 0 || height <= 0 {
        return;
    }
    let len = (width * height * 4) as usize;
    let bytes = unsafe { std::slice::from_raw_parts(buffer, len) };
    let Some(image) = bgra_to_cgimage(bytes, width as usize, height as usize) else {
        return;
    };
    OSR_VIEWS.with(|m| {
        if let Some(view) = m.borrow().get(&window_id) {
            unsafe {
                let layer: *mut AnyObject = msg_send![view, layer];
                if !layer.is_null() {
                    let contents: *const CGImage = &*image;
                    let _: () = msg_send![layer, setContents: contents as *const AnyObject];
                }
            }
        }
    });
}

/// Build a CGImage from a tightly-packed BGRA (premultiplied) pixel buffer.
fn bgra_to_cgimage(bytes: &[u8], width: usize, height: usize) -> Option<CFRetained<CGImage>> {
    let data = CFData::from_bytes(bytes);
    let provider = CGDataProvider::with_cf_data(Some(&data))?;
    let color_space = CGColorSpace::new_device_rgb()?;
    // BGRA premultiplied = 32-bit little-endian byte order, alpha first.
    let bitmap_info = CGBitmapInfo(
        CGImageByteOrderInfo::Order32Little.0
            | objc2_core_graphics::CGImageAlphaInfo::PremultipliedFirst.0,
    );
    unsafe {
        CGImage::new(
            width,
            height,
            8,
            32,
            width * 4,
            Some(&color_space),
            bitmap_info,
            Some(&provider),
            std::ptr::null(),
            false,
            CGColorRenderingIntent::RenderingIntentDefault,
        )
    }
}
