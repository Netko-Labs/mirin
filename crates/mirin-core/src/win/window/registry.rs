use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};

thread_local! {
    /// Live mirin-owned windows, keyed by engine id -> HWND (stored as `isize`).
    /// UI-thread only, where all Win32 + CEF UI work happens.
    static WINDOWS: RefCell<HashMap<u32, isize>> = RefCell::new(HashMap::new());
    /// Windows whose CEF browser close has been acknowledged (`do_close` ran).
    static CLOSING: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    /// Per-window minimum (width, height) in physical px, enforced via
    /// WM_GETMINMAXINFO. Only present for windows that requested a minimum.
    static MIN_SIZE: RefCell<HashMap<u32, (i32, i32)>> = RefCell::new(HashMap::new());
}

pub(super) fn register_window(id: u32, hwnd: HWND) {
    WINDOWS.with(|m| {
        m.borrow_mut().insert(id, hwnd as isize);
    });
}

pub(super) fn remove_window(id: u32) -> Option<HWND> {
    WINDOWS.with(|m| m.borrow_mut().remove(&id).map(|h| h as HWND))
}

pub(super) fn window_ids() -> Vec<u32> {
    WINDOWS.with(|m| m.borrow().keys().copied().collect())
}

pub(crate) fn hwnd_for(id: u32) -> Option<HWND> {
    WINDOWS.with(|m| m.borrow().get(&id).map(|&h| h as HWND))
}

/// The engine id for a top-level HWND, if it's one of ours.
pub fn window_id_for_hwnd(hwnd: HWND) -> Option<u32> {
    let key = hwnd as isize;
    WINDOWS.with(|m| {
        m.borrow()
            .iter()
            .find(|(_, &h)| h == key)
            .map(|(&id, _)| id)
    })
}

/// The engine id owning a CEF browser handle: CEF's browser HWND is a descendant
/// of our top-level window, so walk to the root and match the registry.
pub fn window_id_for_cef_handle(handle: *mut c_void) -> Option<u32> {
    if handle.is_null() {
        return None;
    }
    // SAFETY: `handle` is a live CEF child HWND; GA_ROOT returns its top-level owner.
    let root = unsafe { GetAncestor(handle as HWND, GA_ROOT) };
    window_id_for_hwnd(root)
}

pub(super) fn set_min_size(id: u32, min_width: i32, min_height: i32) {
    MIN_SIZE.with(|m| {
        m.borrow_mut().insert(id, (min_width, min_height));
    });
}

pub(super) fn min_size(id: u32) -> Option<(i32, i32)> {
    MIN_SIZE.with(|m| m.borrow().get(&id).copied())
}

pub(super) fn remove_min_size(id: u32) {
    MIN_SIZE.with(|m| {
        m.borrow_mut().remove(&id);
    });
}

/// Mark `id`'s browser close as acknowledged by CEF (`do_close` ran). The next
/// WM_CLOSE on the window is allowed to destroy it.
pub fn mark_window_closing(id: u32) {
    CLOSING.with(|s| {
        s.borrow_mut().insert(id);
    });
}

pub(super) fn clear_window_closing(id: u32) {
    CLOSING.with(|s| {
        s.borrow_mut().remove(&id);
    });
}

pub(super) fn is_window_closing(id: u32) -> bool {
    CLOSING.with(|s| s.borrow().contains(&id))
}

pub(super) fn empty_rect() -> RECT {
    RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    }
}
