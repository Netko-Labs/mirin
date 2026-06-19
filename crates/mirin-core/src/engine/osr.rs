//! Off-screen rendering, CEF side. Transparent windows can't use a windowed
//! browser (it falls back to opaque white), so they render windowless: CEF
//! paints a BGRA frame we draw into a transparent NSView (mac::osr), and input
//! from that view is forwarded back here into the browser host.
//!
//! All of this runs on the UI/main thread (CEF's render-handler callbacks and
//! AppKit input both fire there), so plain thread-locals are the registry.

use cef::*;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

#[cfg(target_os = "macos")]
use crate::mac;

// Key event type codes shared with mac::osr (CefKeyEventType ordinals).
const KEY_KEYUP: i32 = 2;
const KEY_CHAR: i32 = 3;

thread_local! {
    /// Window ids that render windowless (transparent windows).
    static OSR_WINDOWS: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    /// window id -> its OSR browser, for input dispatch + resize.
    static OSR_BROWSERS: RefCell<HashMap<u32, Browser>> = RefCell::new(HashMap::new());
    /// browser identifier -> window id, for routing on_paint back to a view.
    static BROWSER_TO_WINDOW: RefCell<HashMap<i32, u32>> = RefCell::new(HashMap::new());
}

/// Mark `window_id` as windowless before its browser is created.
pub fn mark_window(window_id: u32) {
    OSR_WINDOWS.with(|s| {
        s.borrow_mut().insert(window_id);
    });
}

/// Whether `window_id` renders windowless (was marked transparent).
pub fn is_osr_window(window_id: u32) -> bool {
    OSR_WINDOWS.with(|s| s.borrow().contains(&window_id))
}

/// Register an OSR browser once created, mapping it to its window both ways.
pub fn register(window_id: u32, browser: Browser) {
    let ident = browser.identifier();
    BROWSER_TO_WINDOW.with(|m| {
        m.borrow_mut().insert(ident, window_id);
    });
    OSR_BROWSERS.with(|m| {
        m.borrow_mut().insert(window_id, browser);
    });
}

/// Drop an OSR browser's registrations on close.
pub fn unregister(browser_ident: i32) {
    let window_id = BROWSER_TO_WINDOW.with(|m| m.borrow_mut().remove(&browser_ident));
    if let Some(window_id) = window_id {
        OSR_BROWSERS.with(|m| {
            m.borrow_mut().remove(&window_id);
        });
        OSR_WINDOWS.with(|s| {
            s.borrow_mut().remove(&window_id);
        });
        #[cfg(target_os = "macos")]
        mac::osr::remove(window_id);
    }
}

fn host(window_id: u32) -> Option<BrowserHost> {
    OSR_BROWSERS
        .with(|m| m.borrow().get(&window_id).cloned())
        .and_then(|b| b.host())
}

fn window_for_browser(browser: &mut Browser) -> Option<u32> {
    let ident = browser.identifier();
    BROWSER_TO_WINDOW.with(|m| m.borrow().get(&ident).copied())
}

// ---- input forwarding (called from mac::osr's view handlers) ----

pub fn mouse_click(
    window_id: u32,
    x: i32,
    y: i32,
    modifiers: u32,
    button: i32,
    up: bool,
    click_count: i32,
) {
    let kind = match button {
        1 => MouseButtonType::RIGHT,
        2 => MouseButtonType::MIDDLE,
        _ => MouseButtonType::LEFT,
    };
    if let Some(host) = host(window_id) {
        let event = MouseEvent { x, y, modifiers };
        host.send_mouse_click_event(Some(&event), kind, up as i32, click_count);
    }
}

pub fn mouse_move(window_id: u32, x: i32, y: i32, modifiers: u32, leave: bool) {
    if let Some(host) = host(window_id) {
        let event = MouseEvent { x, y, modifiers };
        host.send_mouse_move_event(Some(&event), leave as i32);
    }
}

pub fn mouse_wheel(window_id: u32, x: i32, y: i32, delta_x: i32, delta_y: i32, modifiers: u32) {
    if let Some(host) = host(window_id) {
        let event = MouseEvent { x, y, modifiers };
        host.send_mouse_wheel_event(Some(&event), delta_x, delta_y);
    }
}

pub fn key(
    window_id: u32,
    type_code: i32,
    modifiers: u32,
    windows_key_code: i32,
    native_key_code: i32,
    character: u16,
    unmodified: u16,
) {
    let type_ = match type_code {
        KEY_KEYUP => KeyEventType::KEYUP,
        KEY_CHAR => KeyEventType::CHAR,
        _ => KeyEventType::RAWKEYDOWN,
    };
    if let Some(host) = host(window_id) {
        let event = KeyEvent {
            size: std::mem::size_of::<sys::_cef_key_event_t>(),
            type_,
            modifiers,
            windows_key_code,
            native_key_code,
            is_system_key: 0,
            character,
            unmodified_character: unmodified,
            focus_on_editable_field: 0,
        };
        host.send_key_event(Some(&event));
    }
}

/// Tell CEF the windowless view changed size (re-queries view_rect, repaints).
pub fn resized(window_id: u32) {
    if let Some(host) = host(window_id) {
        host.was_resized();
    }
}

// ---- render handler ----

wrap_render_handler! {
    struct MirinRenderHandler {}

    impl RenderHandler {
        fn view_rect(&self, browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            let Some(rect) = rect else { return };
            rect.x = 0;
            rect.y = 0;
            // Logical size of the OSR view; fall back to a sane default so CEF
            // never sees a zero rect (which it rejects).
            let size = browser.and_then(window_for_browser).and_then(view_size);
            let (w, h) = size.filter(|&(w, h)| w > 0 && h > 0).unwrap_or((800, 600));
            rect.width = w;
            rect.height = h;
        }

        fn screen_info(
            &self,
            browser: Option<&mut Browser>,
            screen_info: Option<&mut ScreenInfo>,
        ) -> ::std::os::raw::c_int {
            let Some(info) = screen_info else { return 0 };
            let scale = browser
                .and_then(window_for_browser)
                .and_then(view_scale)
                .unwrap_or(2.0);
            info.device_scale_factor = scale;
            1
        }

        fn on_paint(
            &self,
            browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            buffer: *const u8,
            width: ::std::os::raw::c_int,
            height: ::std::os::raw::c_int,
        ) {
            if type_ != PaintElementType::VIEW {
                return; // ignore popup (e.g. <select>) layers for now
            }
            let Some(window_id) = browser.and_then(window_for_browser) else {
                return;
            };
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            paint(window_id, buffer, width, height);
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let _ = (window_id, buffer, width, height);
        }
    }
}

pub fn render_handler() -> RenderHandler {
    MirinRenderHandler::new()
}

// ---- platform shims (keep the render handler portable) ----

#[cfg(target_os = "macos")]
fn view_size(window_id: u32) -> Option<(i32, i32)> {
    mac::osr::view_size(window_id)
}
#[cfg(target_os = "macos")]
fn view_scale(window_id: u32) -> Option<f32> {
    mac::osr::scale(window_id)
}
#[cfg(target_os = "macos")]
fn paint(window_id: u32, buffer: *const u8, width: i32, height: i32) {
    // Safety: this is the CEF on_paint buffer — valid for width*height*4 BGRA
    // bytes for the duration of the callback.
    unsafe { mac::osr::paint(window_id, buffer, width, height) };
}

#[cfg(target_os = "windows")]
fn view_size(window_id: u32) -> Option<(i32, i32)> {
    crate::win::osr::view_size(window_id)
}
#[cfg(target_os = "windows")]
fn view_scale(window_id: u32) -> Option<f32> {
    crate::win::osr::scale(window_id)
}
#[cfg(target_os = "windows")]
fn paint(window_id: u32, buffer: *const u8, width: i32, height: i32) {
    // Safety: CEF's on_paint buffer is valid for width*height*4 BGRA bytes for the
    // duration of the callback.
    unsafe { crate::win::osr::paint(window_id, buffer, width, height) };
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn view_size(_window_id: u32) -> Option<(i32, i32)> {
    None
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn view_scale(_window_id: u32) -> Option<f32> {
    None
}
