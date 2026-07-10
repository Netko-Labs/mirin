use cef::*;
use std::cell::RefCell;
use std::os::raw::{c_int, c_long, c_ulong};

use super::x11::with_xlib;

thread_local! {
    /// The app icon as a ready `_NET_WM_ICON` payload (`[w, h, argb...]` as
    /// `c_long`s), decoded once from the init config's PNG.
    static WM_ICON: RefCell<Option<Option<Vec<c_long>>>> = const { RefCell::new(None) };
}

/// The delays (ms) at which we re-assert `WM_CLASS`/`_NET_WM_ICON` after a window
/// maps, to out-run Chromium's own writes during X11 window realization.
const PROPS_REASSERT_DELAYS_MS: [i64; 3] = [50, 300, 900];

/// Decode the init config's icon PNG into a `_NET_WM_ICON` payload, once (cached).
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
    let bps = if info.bit_depth == png::BitDepth::Sixteen {
        2
    } else {
        1
    };
    let spp = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return None,
    };
    let stride = w * spp * bps;
    let mut data: Vec<c_long> = Vec::with_capacity(2 + w * h);
    data.push(w as c_long);
    data.push(h as c_long);
    for y in 0..h {
        for x in 0..w {
            let p = y * stride + x * spp * bps;
            let s = |i: usize| buf[p + i * bps] as u32;
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
fn write_net_wm_icon(xid: u64) {
    WM_ICON.with(|cell| {
        {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(net_wm_icon_data());
            }
        }
        let slot = cell.borrow();
        let Some(Some(data)) = slot.as_ref() else {
            return;
        };
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

/// Set the window's `WM_CLASS` (app-id) from the app's bundle id.
fn write_wm_class(xid: u64) {
    let Some((res_name, res_class)) = crate::engine::wm_class() else {
        return;
    };
    let (Ok(res_name), Ok(res_class)) = (
        std::ffi::CString::new(res_name),
        std::ffi::CString::new(res_class),
    ) else {
        return;
    };
    with_xlib(|xlib, display| unsafe {
        // XSetClassHint reads the hint and does not mutate the strings.
        let mut hint = x11_dl::xlib::XClassHint {
            res_name: res_name.as_ptr() as *mut _,
            res_class: res_class.as_ptr() as *mut _,
        };
        (xlib.XSetClassHint)(display, xid as c_ulong, &mut hint);
        (xlib.XFlush)(display);
    });
}

/// Set the window's app identity + icon now and re-assert them shortly after.
pub(super) fn install_window_props(xid: u64) {
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
