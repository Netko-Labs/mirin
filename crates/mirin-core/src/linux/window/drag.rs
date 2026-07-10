use std::cell::RefCell;
use std::collections::HashMap;

use super::controls::control;
use super::state::window_xid;
use super::x11::{disable_frame_sync, net_wm_moveresize};

thread_local! {
    /// window_id -> the page's `-webkit-app-region` rects (x, y, w, h,
    /// draggable), CSS px.
    static DRAG_REGIONS: RefCell<HashMap<u32, Vec<(i32, i32, i32, i32, bool)>>> =
        RefCell::new(HashMap::new());
}

/// Replace the draggable `-webkit-app-region` rects for a window.
pub fn set_draggable_regions(window_id: u32, regions: Vec<(i32, i32, i32, i32, bool)>) {
    DRAG_REGIONS.with(|m| {
        m.borrow_mut().insert(window_id, regions);
    });
}

/// Whether logical point (x, y) is on a draggable region (no-drag rects on top win).
fn point_draggable(window_id: u32, x: i32, y: i32) -> bool {
    DRAG_REGIONS.with(|m| {
        let map = m.borrow();
        let Some(regions) = map.get(&window_id) else {
            return false;
        };
        let mut draggable = false;
        for &(rx, ry, rw, rh, drag) in regions {
            if x >= rx && x < rx + rw && y >= ry && y < ry + rh {
                draggable = drag;
            }
        }
        draggable
    })
}

/// Map the preload's Win32-style hit-test code to a `_NET_WM_MOVERESIZE` direction.
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

/// Handle a preload `window.maybeStartDrag`: edge -> resize, double-click on the
/// title bar -> toggle maximize, otherwise a title-bar press -> move.
pub fn maybe_start_drag(window_id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    let Some(xid) = window_xid(window_id) else {
        return;
    };
    if let Some(direction) = ht_to_direction(ht) {
        disable_frame_sync(xid);
        net_wm_moveresize(xid, direction);
        return;
    }
    if !point_draggable(window_id, x, y) {
        return;
    }
    if detail >= 2 {
        control(window_id, "maximize");
    } else {
        net_wm_moveresize(xid, 8);
    }
}
