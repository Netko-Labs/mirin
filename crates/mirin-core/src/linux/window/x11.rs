use std::cell::RefCell;
use std::os::raw::{c_int, c_long, c_uint, c_ulong};

thread_local! {
    /// Lazily-opened Xlib handle + Display for `_NET_WM_MOVERESIZE` and
    /// `WM_CLASS`/`_NET_WM_ICON` writes. UI thread only.
    static XLIB: RefCell<Option<(x11_dl::xlib::Xlib, *mut x11_dl::xlib::Display)>> =
        RefCell::new(None);
}

pub(super) fn with_xlib<R>(
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
/// interactive resize the WM otherwise blocks on Chromium's frame-sync counter.
pub(super) fn disable_frame_sync(xid: u64) {
    with_xlib(|xlib, display| unsafe {
        let window = xid as c_ulong;
        let counter = (xlib.XInternAtom)(display, c"_NET_WM_SYNC_REQUEST_COUNTER".as_ptr(), 0);
        (xlib.XDeleteProperty)(display, window, counter);
        (xlib.XFlush)(display);
    });
}

/// Ask the WM to start a move (`direction` 8) or resize (0..=7) of `xid`.
pub(super) fn net_wm_moveresize(xid: u64, direction: i64) {
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
