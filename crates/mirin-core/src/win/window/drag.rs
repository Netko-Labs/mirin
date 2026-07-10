use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetCursorPos, IsZoomed, PostMessageW, ScreenToClient, HTBOTTOM, HTBOTTOMLEFT,
    HTBOTTOMRIGHT, HTCAPTION, HTCLIENT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
    WM_NCLBUTTONDOWN,
};

use super::controls::control;
use super::dpi::{dpi_scale, resize_border_px};
use super::registry::{empty_rect, hwnd_for};
use super::types::DragRegion;

/// Height of the fallback draggable strip (DIP) used before the page reports any
/// `-webkit-app-region` regions.
const TITLE_BAR_DRAG_HEIGHT: f64 = 38.0;

thread_local! {
    /// Windows with a custom (frameless) title bar.
    static CUSTOM_TITLEBARS: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    /// `-webkit-app-region` regions reported by CEF, per custom-title-bar window.
    static DRAG_REGIONS: RefCell<HashMap<u32, Vec<DragRegion>>> = RefCell::new(HashMap::new());
}

pub(super) fn mark_custom_titlebar(id: u32) {
    CUSTOM_TITLEBARS.with(|s| {
        s.borrow_mut().insert(id);
    });
}

pub(super) fn clear_custom_titlebar(id: u32) {
    CUSTOM_TITLEBARS.with(|s| {
        s.borrow_mut().remove(&id);
    });
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().remove(&id);
    });
}

pub(super) fn is_custom(id: u32) -> bool {
    CUSTOM_TITLEBARS.with(|s| s.borrow().contains(&id))
}

/// Replace the `-webkit-app-region` regions for a custom-title-bar window.
pub fn set_draggable_regions(id: u32, regions: Vec<DragRegion>) {
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().insert(id, regions);
    });
}

/// Begin a native window-move for `id`.
pub fn maybe_start_drag(id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    if ht != 0 {
        start_nc_drag(id, ht);
        return;
    }
    let (dx, dy) = (x as f64, y as f64);
    let draggable = DRAG_REGIONS.with(|r| {
        let map = r.borrow();
        match map.get(&id).filter(|v| !v.is_empty()) {
            Some(regions) => {
                let mut in_drag = false;
                let mut in_hole = false;
                for region in regions {
                    let inside = dx >= region.x
                        && dx <= region.x + region.w
                        && dy >= region.y
                        && dy <= region.y + region.h;
                    if inside {
                        if region.draggable {
                            in_drag = true;
                        } else {
                            in_hole = true;
                        }
                    }
                }
                in_drag && !in_hole
            }
            None => dy < TITLE_BAR_DRAG_HEIGHT,
        }
    });
    if !draggable {
        return;
    }
    if detail >= 2 {
        control(id, "maximize");
    } else {
        start_nc_drag(id, HTCAPTION as i32);
    }
}

/// Hand off to Windows' built-in non-client drag loop at the current cursor.
fn start_nc_drag(id: u32, ht: i32) {
    let Some(hwnd) = hwnd_for(id) else { return };
    let mut pt = POINT { x: 0, y: 0 };
    // SAFETY: valid out-param + live hwnd; PostMessageW is thread-safe and
    // ReleaseCapture runs on the UI thread.
    unsafe {
        GetCursorPos(&mut pt);
        ReleaseCapture();
        let lparam = (pt.x as i16 as u16 as isize) | ((pt.y as i16 as u16 as isize) << 16);
        PostMessageW(hwnd, WM_NCLBUTTONDOWN, ht as WPARAM, lparam);
    }
}

/// Whether a client-space point (physical px) lies in a draggable title-bar area.
fn point_is_draggable(id: u32, px: i32, py: i32, scale: f64) -> bool {
    DRAG_REGIONS.with(|r| {
        let map = r.borrow();
        match map.get(&id).filter(|v| !v.is_empty()) {
            Some(regions) => {
                let (dx, dy) = (px as f64 / scale, py as f64 / scale);
                let mut in_drag = false;
                let mut in_hole = false;
                for region in regions {
                    let inside = dx >= region.x
                        && dx <= region.x + region.w
                        && dy >= region.y
                        && dy <= region.y + region.h;
                    if inside {
                        if region.draggable {
                            in_drag = true;
                        } else {
                            in_hole = true;
                        }
                    }
                }
                in_drag && !in_hole
            }
            None => (py as f64) < TITLE_BAR_DRAG_HEIGHT * scale,
        }
    })
}

/// Hit-test a custom-title-bar window: synthesize resize edges/corners, then
/// return `HTCAPTION` over draggable title-bar areas.
pub(super) fn custom_hit_test(hwnd: HWND, id: u32, lparam: LPARAM) -> LRESULT {
    let mut pt = POINT {
        x: (lparam & 0xFFFF) as i16 as i32,
        y: ((lparam >> 16) & 0xFFFF) as i16 as i32,
    };
    // SAFETY: valid hwnd + point.
    unsafe { ScreenToClient(hwnd, &mut pt) };
    let mut rc = empty_rect();
    // SAFETY: valid hwnd + out-param.
    unsafe { GetClientRect(hwnd, &mut rc) };
    let (cw, ch) = (rc.right - rc.left, rc.bottom - rc.top);
    let _ = ch;

    // SAFETY: pure query.
    let maximized = unsafe { IsZoomed(hwnd) } != 0;
    if !maximized {
        let b = resize_border_px();
        let left = pt.x < b;
        let right = pt.x >= cw - b;
        let top = pt.y < b;
        let bottom = pt.y >= ch - b;
        let edge = match (top, bottom, left, right) {
            (true, _, true, _) => Some(HTTOPLEFT),
            (true, _, _, true) => Some(HTTOPRIGHT),
            (_, true, true, _) => Some(HTBOTTOMLEFT),
            (_, true, _, true) => Some(HTBOTTOMRIGHT),
            (true, ..) => Some(HTTOP),
            (_, true, ..) => Some(HTBOTTOM),
            (_, _, true, _) => Some(HTLEFT),
            (_, _, _, true) => Some(HTRIGHT),
            _ => None,
        };
        if let Some(edge) = edge {
            return edge as LRESULT;
        }
    }

    let scale = dpi_scale(hwnd);
    if point_is_draggable(id, pt.x, pt.y, scale) {
        HTCAPTION as LRESULT
    } else {
        HTCLIENT as LRESULT
    }
}
