//! Linux (X11/Ozone) windowing via the CEF **Views** framework.
//!
//! Unlike Windows (a CEF child HWND parented to a mirin-owned top-level window) or
//! macOS (CEF painting into a mirin-owned NSView), the Linux port does not own a
//! native toolkit window. Instead CEF's Views framework owns a real X11 toplevel
//! (`window_create_top_level`) hosting a `BrowserView` (`browser_view_create`).
//! mirin drives it through the Views delegates + the id→Window registry here, and
//! manages the window itself via Xlib (`x11-dl`, dlopens libX11 — no build-time X11
//! dev libs) against the CEF window's XID: move/resize via `_NET_WM_MOVERESIZE`,
//! maximize/fullscreen/always-on-top via `_NET_WM_STATE`, and `WM_CLASS` +
//! `_NET_WM_ICON` for the taskbar/dock.
//!
//! Ozone is forced to X11 at runtime (`--ozone-platform=x11`, appended in engine's
//! command-line handler; override via `MIRIN_OZONE`); on Wayland sessions this runs
//! under XWayland. All Views calls are UI-thread only.

use cef::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::os::raw::{c_int, c_long, c_uint, c_ulong};

/// A created window: the top-level Views `Window`. The `BrowserView` lives inside
/// the window delegate (dropped on window destroy); we key the window by mirin's
/// `window_id`, which we also stamp onto the browser view's `View::id` so
/// `on_after_created` can map a Browser back to its window.
struct WindowEntry {
    window: Window,
}

thread_local! {
    /// window_id → live top-level Window. UI-thread only (Views types aren't Send).
    static WINDOWS: RefCell<HashMap<u32, WindowEntry>> = RefCell::new(HashMap::new());
    /// window_id → the page's `-webkit-app-region` rects (x, y, w, h, draggable), CSS px.
    /// From CEF's DragHandler; used to decide whether a title-bar press starts a move.
    static DRAG_REGIONS: RefCell<HashMap<u32, Vec<(i32, i32, i32, i32, bool)>>> =
        RefCell::new(HashMap::new());
    /// Lazily-opened Xlib handle + Display for `_NET_WM_MOVERESIZE` (UI thread only).
    static XLIB: RefCell<Option<(x11_dl::xlib::Xlib, *mut x11_dl::xlib::Display)>> =
        RefCell::new(None);
    /// The app icon as a ready `_NET_WM_ICON` payload (`[w, h, argb…]` as `c_long`s;
    /// see `net_wm_icon_data`), decoded once from the init config's PNG. `None` = not
    /// yet built; `Some(None)` = no icon configured / decode failed (don't retry).
    static WM_ICON: RefCell<Option<Option<Vec<c_long>>>> = const { RefCell::new(None) };
}

// ---- delegates ------------------------------------------------------------

// Minimal browser-view delegate. Popups (window.open / target=_blank) get their
// own top-level Views window, mirroring cefsimple.
wrap_browser_view_delegate! {
    pub struct MirinBrowserViewDelegate {}

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: i32,
        ) -> i32 {
            let mut delegate = MirinWindowDelegate::new(
                RefCell::new(popup_browser_view.cloned()),
                String::new(),
                0,
                0,
                true,
                false,
                false, // popups get standard decorations
            );
            window_create_top_level(Some(&mut delegate));
            1
        }

        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

// Top-level window delegate: attaches the browser view, sizes/shows the window,
// and routes close through the browser (`try_close_browser` → LifeSpanHandler
// `do_close`/`on_before_close`, which quits on the last one).
wrap_window_delegate! {
    pub struct MirinWindowDelegate {
        browser_view: RefCell<Option<BrowserView>>,
        title: String,
        width: i32,
        height: i32,
        show: bool,
        always_on_top: bool,
        // Custom title bar (`titleBarStyle: hidden`/`hiddenInset`): a frameless
        // Views window with no native caption/border. The app draws its own header
        // and marks it `-webkit-app-region: drag`; CEF Views' BrowserView forwards
        // those regions to the frameless window, so dragging/double-click-maximize
        // work without any manual hit-testing (unlike the win/ manual-drag path).
        frameless: bool,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: self.width.max(1), height: self.height.max(1) }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        // Frameless (titleBarStyle: hidden). On X11 (the default, incl. XWayland) this
        // gives a truly borderless window — the app draws its own chrome and mirin
        // drives move/resize via _NET_WM_MOVERESIZE (see maybe_start_drag).
        fn is_frameless(&self, _window: Option<&mut Window>) -> i32 {
            self.frameless as i32
        }

        // CEF's can_* delegate methods DEFAULT TO FALSE. A non-resizable window gets
        // fixed WM size hints, so the compositor refuses `_NET_WM_MOVERESIZE` resize
        // (move still works — it isn't gated). Allow all three so a frameless window
        // can be resized, maximized and minimized.
        fn can_resize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn on_window_created(&self, window: Option<&mut Window>) {
            let browser_view = self.browser_view.borrow();
            let (Some(window), Some(browser_view)) = (window, browser_view.as_ref()) else {
                return;
            };
            // Fill layout so the browser view tracks the window size — without it the
            // view keeps its initial size and the content doesn't follow a resize.
            let _ = window.set_to_fill_layout();
            let mut view = View::from(browser_view);
            window.add_child_view(Some(&mut view));

            if !self.title.is_empty() {
                window.set_title(Some(&CefString::from(self.title.as_str())));
            }
            if self.width > 0 && self.height > 0 {
                window.center_window(Some(&Size { width: self.width, height: self.height }));
            }
            if self.always_on_top {
                window.set_always_on_top(1);
            }
            // Set the window's app identity + taskbar/dock icon (`WM_CLASS` +
            // `_NET_WM_ICON`, read by cosmic's dock). Applied after show() below,
            // once the window has mapped (see install_window_props).
            if self.show {
                window.show();
                // Raise + focus the fresh toplevel: on Wayland a compositor may map
                // a new window behind the focused one, so an explicit activate keeps
                // the app in front (matches the "new app window comes forward" UX).
                window.activate();
            }
            install_window_props(window.window_handle() as u64);
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            *self.browser_view.borrow_mut() = None;
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let browser_view = self.browser_view.borrow();
            let Some(browser_view) = browser_view.as_ref() else { return 1 };
            if let Some(browser) = browser_view.browser() {
                if let Some(host) = browser.host() {
                    return host.try_close_browser();
                }
            }
            1
        }

        fn window_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

// ---- creation + registry --------------------------------------------------

/// Stamp mirin's `window_id` onto the browser view's `View::id`, so the shared
/// LifeSpanHandler can map a Browser → window in `on_after_created`.
pub fn tag_browser_view(browser_view: &BrowserView, window_id: u32) {
    let view = View::from(browser_view);
    view.set_id(window_id as i32);
}

/// Record a created top-level window so later commands (title/close/control) can
/// find it by id.
pub fn register_window(window_id: u32, window: Window) {
    WINDOWS.with(|w| w.borrow_mut().insert(window_id, WindowEntry { window }));
}

/// Map a live Browser back to the mirin `window_id` we stamped on its browser
/// view (`tag_browser_view`). `None` if it isn't one of ours.
pub fn window_id_for_browser(browser: &mut Browser) -> Option<u32> {
    let browser_view = browser_view_get_for_browser(Some(browser))?;
    let id = View::from(&browser_view).id();
    (id > 0).then_some(id as u32)
}

pub fn close_window(window_id: u32) {
    WINDOWS.with(|w| {
        if let Some(entry) = w.borrow_mut().remove(&window_id) {
            if entry.window.is_closed() == 0 {
                entry.window.close();
            }
        }
    });
}

pub fn close_all_windows() {
    WINDOWS.with(|w| {
        for (_, entry) in w.borrow_mut().drain() {
            if entry.window.is_closed() == 0 {
                entry.window.close();
            }
        }
    });
}

pub fn set_window_title(window_id: u32, title: &str) {
    WINDOWS.with(|w| {
        if let Some(entry) = w.borrow().get(&window_id) {
            entry.window.set_title(Some(&CefString::from(title)));
        }
    });
}

/// Apply a window-control verb (minimize/maximize/restore/fullscreen/focus/…).
pub fn control(window_id: u32, verb: &str) {
    WINDOWS.with(|w| {
        let windows = w.borrow();
        let Some(entry) = windows.get(&window_id) else { return };
        let window = &entry.window;
        match verb {
            "minimize" => window.minimize(),
            // Toggle so the app's single maximize button (and a title-bar double-click)
            // both maximize and restore.
            "maximize" | "togglemaximize" => {
                if window.is_maximized() != 0 {
                    window.restore();
                } else {
                    window.maximize();
                }
            }
            "restore" | "unmaximize" => window.restore(),
            "fullscreen" | "togglefullscreen" => {
                window.set_fullscreen((window.is_fullscreen() == 0) as i32);
            }
            "unfullscreen" => window.set_fullscreen(0),
            "focus" | "activate" => window.activate(),
            "blur" | "deactivate" => window.deactivate(),
            "show" => window.show(),
            "hide" => window.hide(),
            // The client sends `alwaysOnTop:on`/`:off`; accept the `:true`/`:false`
            // spelling too. Works on X11 (_NET_WM_STATE_ABOVE).
            "alwaysOnTop:on" | "alwaysOnTop:true" => window.set_always_on_top(1),
            "alwaysOnTop:off" | "alwaysOnTop:false" => window.set_always_on_top(0),
            _ => {}
        }
    });
}

/// Move a window's top-left origin to screen point (x, y).
pub fn set_position(window_id: u32, x: f64, y: f64) {
    WINDOWS.with(|w| {
        if let Some(entry) = w.borrow().get(&window_id) {
            let b = entry.window.bounds();
            entry.window.set_bounds(Some(&Rect {
                x: x as i32,
                y: y as i32,
                width: b.width,
                height: b.height,
            }));
        }
    });
}

// ---- custom title bar: move / resize / maximize (X11) ---------------------
//
// A frameless CEF Views window has no WM caption or resize border, so mirin drives
// window management itself. The renderer's preload forwards each left mousedown as
// `window.maybeStartDrag` with the CSS-px coords, the click `detail`, and a hit-test
// `ht` (edge code); we translate that into `_NET_WM_MOVERESIZE` against the CEF
// window's XID (Electrobun's approach — works on X11 and, via XWayland, on Wayland).

/// Replace the draggable `-webkit-app-region` rects for a window (CEF DragHandler).
pub fn set_draggable_regions(window_id: u32, regions: Vec<(i32, i32, i32, i32, bool)>) {
    DRAG_REGIONS.with(|m| {
        m.borrow_mut().insert(window_id, regions);
    });
}

/// Whether logical point (x, y) is on a draggable region (no-drag rects on top win).
fn point_draggable(window_id: u32, x: i32, y: i32) -> bool {
    DRAG_REGIONS.with(|m| {
        let map = m.borrow();
        let Some(regions) = map.get(&window_id) else { return false };
        let mut draggable = false;
        for &(rx, ry, rw, rh, drag) in regions {
            if x >= rx && x < rx + rw && y >= ry && y < ry + rh {
                draggable = drag;
            }
        }
        draggable
    })
}

/// The X11 window id (XID) backing a window's CEF Views toplevel.
fn window_xid(window_id: u32) -> Option<u64> {
    WINDOWS.with(|w| w.borrow().get(&window_id).map(|e| e.window.window_handle() as u64))
}

/// Map the preload's Win32-style hit-test code to a `_NET_WM_MOVERESIZE` direction
/// (L10 R11 T12 TL13 TR14 B15 BL16 BR17 → 7 3 1 0 2 5 6 4). `None` = not an edge.
fn ht_to_direction(ht: i32) -> Option<i64> {
    Some(match ht {
        10 => 7, // left
        11 => 3, // right
        12 => 1, // top
        13 => 0, // top-left
        14 => 2, // top-right
        15 => 5, // bottom
        16 => 6, // bottom-left
        17 => 4, // bottom-right
        _ => return None,
    })
}

fn with_xlib<R>(
    f: impl FnOnce(&x11_dl::xlib::Xlib, *mut x11_dl::xlib::Display) -> R,
) -> Option<R> {
    XLIB.with(|c| {
        let mut slot = c.borrow_mut();
        if slot.is_none() {
            if let Ok(lib) = x11_dl::xlib::Xlib::open() {
                let display = unsafe { (lib.XOpenDisplay)(std::ptr::null()) };
                if !display.is_null() {
                    *slot = Some((lib, display));
                }
            }
        }
        slot.as_ref().map(|(lib, display)| f(lib, *display))
    })
}

/// Delete Chromium's `_NET_WM_SYNC_REQUEST_COUNTER` from the window. During an
/// interactive resize the WM otherwise blocks on that basic-frame-sync counter,
/// waiting for Chromium to signal each painted frame — a handshake that stalls under
/// XWayland/cosmic, so the window only resizes when the drag is released. Without the
/// counter the compositor resizes live (Chromium repaints as it can). Idempotent.
fn disable_frame_sync(xid: u64) {
    with_xlib(|xlib, display| unsafe {
        let window = xid as c_ulong;
        let counter = (xlib.XInternAtom)(display, c"_NET_WM_SYNC_REQUEST_COUNTER".as_ptr(), 0);
        (xlib.XDeleteProperty)(display, window, counter);
        (xlib.XFlush)(display);
    });
}

/// Ask the WM to start a move (`direction` 8) or resize (0..=7) of `xid`, anchored at
/// the current pointer position — the standard `_NET_WM_MOVERESIZE` handshake.
fn net_wm_moveresize(xid: u64, direction: i64) {
    with_xlib(|xlib, display| unsafe {
        let window = xid as c_ulong;
        let (mut root, mut child): (c_ulong, c_ulong) = (0, 0);
        let (mut rx, mut ry, mut wx, mut wy): (c_int, c_int, c_int, c_int) = (0, 0, 0, 0);
        let mut mask: c_uint = 0;
        (xlib.XQueryPointer)(
            display, window, &mut root, &mut child, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask,
        );
        let atom = (xlib.XInternAtom)(display, c"_NET_WM_MOVERESIZE".as_ptr(), 0);
        let mut ev: x11_dl::xlib::XEvent = std::mem::zeroed();
        ev.client_message.type_ = x11_dl::xlib::ClientMessage;
        ev.client_message.window = window;
        ev.client_message.message_type = atom;
        ev.client_message.format = 32;
        ev.client_message.data.set_long(0, rx as c_long);
        ev.client_message.data.set_long(1, ry as c_long);
        ev.client_message.data.set_long(2, direction as c_long);
        ev.client_message.data.set_long(3, 1); // Button1
        ev.client_message.data.set_long(4, 1); // source: normal application
        let root_win = (xlib.XDefaultRootWindow)(display);
        (xlib.XSendEvent)(
            display,
            root_win,
            0,
            x11_dl::xlib::SubstructureRedirectMask | x11_dl::xlib::SubstructureNotifyMask,
            &mut ev,
        );
        (xlib.XFlush)(display);
    });
}

/// Handle a preload `window.maybeStartDrag`: edge → resize, double-click on the
/// title bar → toggle maximize, otherwise a title-bar press → move.
pub fn maybe_start_drag(window_id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    let Some(xid) = window_xid(window_id) else { return };
    if let Some(direction) = ht_to_direction(ht) {
        // Drop the frame-sync counter so the compositor resizes live instead of
        // blocking on Chromium's per-frame ack (which stalls under XWayland/cosmic).
        disable_frame_sync(xid);
        net_wm_moveresize(xid, direction);
        return;
    }
    if !point_draggable(window_id, x, y) {
        return;
    }
    if detail >= 2 {
        control(window_id, "maximize"); // toggles
    } else {
        net_wm_moveresize(xid, 8); // _NET_WM_MOVERESIZE_MOVE
    }
}

// ---- app identity + taskbar / dock icon (`WM_CLASS` + `_NET_WM_ICON`, X11) --
//
// cosmic's dock identifies an X11 window by its `WM_CLASS` (app-id) and only then
// resolves an icon — a `.desktop` match, else the window's `_NET_WM_ICON`. A CEF
// Alloy Views window ships with neither, so mirin sets both itself:
//   • `WM_CLASS` = (res_name, res_class) from the app's bundle id (engine::wm_class),
//     so cosmic can associate + group the window with the app.
//   • `_NET_WM_ICON` = the app icon pixels, a flat array of 32-bit CARDINALs
//     `[w, h, argb0, argb1, …]` (each pixel `0xAARRGGBB`), which the dock renders.
//
// Chromium ALSO manages these while realizing the X11 window (empty icon, and it can
// rewrite WM_CLASS), which clobbers values we set during creation. So we (re)assert
// ours *after* the window maps — immediately post-show and again on a few short
// delayed UI tasks — so the last writer, us, wins.

/// The delays (ms) at which we re-assert `WM_CLASS`/`_NET_WM_ICON` after a window
/// maps, to out-run Chromium's own writes during X11 window realization.
const PROPS_REASSERT_DELAYS_MS: [i64; 3] = [50, 300, 900];

/// Decode the init config's icon PNG into a `_NET_WM_ICON` payload, once (cached).
/// Returns `[w, h, argb…]` as `c_long`s — the X11 wire form for `format == 32`
/// (see `write_net_wm_icon`). Empty path or a decode error yields `None`. The
/// `.png`/`.iconset` → concrete-PNG resolution happens host-side.
fn net_wm_icon_data() -> Option<Vec<c_long>> {
    let path = crate::engine::icon_path();
    if path.is_empty() {
        return None;
    }
    let file = std::fs::File::open(&path).ok()?;
    let mut reader = png::Decoder::new(file).read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    // 16-bit samples are byte pairs (big-endian); take the high byte for 8-bit.
    let bps = if info.bit_depth == png::BitDepth::Sixteen { 2 } else { 1 };
    // Samples per pixel for the (possibly non-RGBA) source color type.
    let spp = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        // Indexed is expanded to RGB(A) by the decoder before we get here.
        png::ColorType::Indexed => return None,
    };
    let stride = w * spp * bps;
    let mut data: Vec<c_long> = Vec::with_capacity(2 + w * h);
    data.push(w as c_long);
    data.push(h as c_long);
    for y in 0..h {
        for x in 0..w {
            let p = y * stride + x * spp * bps;
            let s = |i: usize| buf[p + i * bps] as u32; // high byte of each sample
            let (r, g, b, a) = match info.color_type {
                png::ColorType::Grayscale => (s(0), s(0), s(0), 0xFF),
                png::ColorType::GrayscaleAlpha => (s(0), s(0), s(0), s(1)),
                png::ColorType::Rgb => (s(0), s(1), s(2), 0xFF),
                png::ColorType::Rgba => (s(0), s(1), s(2), s(3)),
                png::ColorType::Indexed => unreachable!(),
            };
            data.push(((a << 24) | (r << 16) | (g << 8) | b) as c_long);
        }
    }
    Some(data)
}

/// Write the cached `_NET_WM_ICON` onto `xid` (no-op if no icon is configured).
/// CRITICAL: for `format == 32`, XChangeProperty reads the data as an array of C
/// `long` (64-bit here), not `u32` — so we pass the `Vec<c_long>` bytes with
/// `nelements` = its length.
fn write_net_wm_icon(xid: u64) {
    WM_ICON.with(|cell| {
        {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(net_wm_icon_data());
            }
        }
        let slot = cell.borrow();
        let Some(Some(data)) = slot.as_ref() else { return };
        with_xlib(|xlib, display| unsafe {
            let atom = (xlib.XInternAtom)(display, c"_NET_WM_ICON".as_ptr(), 0);
            (xlib.XChangeProperty)(
                display,
                xid as c_ulong,
                atom,
                x11_dl::xlib::XA_CARDINAL,
                32,
                x11_dl::xlib::PropModeReplace,
                data.as_ptr() as *const u8,
                data.len() as c_int,
            );
            (xlib.XFlush)(display);
        });
    });
}

/// Set the window's `WM_CLASS` (app-id) from the app's bundle id, so cosmic can
/// identify + group it. No-op when no id is configured.
fn write_wm_class(xid: u64) {
    let Some((res_name, res_class)) = crate::engine::wm_class() else { return };
    let (Ok(res_name), Ok(res_class)) =
        (std::ffi::CString::new(res_name), std::ffi::CString::new(res_class))
    else {
        return;
    };
    with_xlib(|xlib, display| unsafe {
        // XSetClassHint reads the hint (doesn't mutate the strings), so casting the
        // CString pointers to `*mut` is sound for the duration of the call.
        let mut hint = x11_dl::xlib::XClassHint {
            res_name: res_name.as_ptr() as *mut _,
            res_class: res_class.as_ptr() as *mut _,
        };
        (xlib.XSetClassHint)(display, xid as c_ulong, &mut hint);
        (xlib.XFlush)(display);
    });
}

/// Set the window's app identity + icon now and re-assert them shortly after, so
/// our `WM_CLASS`/`_NET_WM_ICON` survive Chromium's map-time writes. A no-op
/// (aside from cheap checks) when neither an id nor an icon is configured.
fn install_window_props(xid: u64) {
    let has_icon = WM_ICON.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(net_wm_icon_data());
        }
        matches!(slot.as_ref(), Some(Some(_)))
    });
    let has_class = crate::engine::wm_class().is_some();
    if !has_icon && !has_class {
        return;
    }
    write_window_props(xid);
    for delay in PROPS_REASSERT_DELAYS_MS {
        let mut task = SetWindowPropsTask::new(xid);
        post_delayed_task(ThreadId::UI, Some(&mut task), delay);
    }
}

/// Write both window properties (`WM_CLASS` then `_NET_WM_ICON`) onto `xid`.
fn write_window_props(xid: u64) {
    write_wm_class(xid);
    write_net_wm_icon(xid);
}

// Re-assert `WM_CLASS`/`_NET_WM_ICON` on `xid` from a delayed UI task (see
// `install_window_props`). UI-thread only, matching the Xlib usage here.
wrap_task! {
    struct SetWindowPropsTask {
        xid: u64,
    }
    impl Task {
        fn execute(&self) {
            write_window_props(self.xid);
        }
    }
}
