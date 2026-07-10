use cef::Window;
use std::cell::RefCell;
use std::collections::HashMap;

/// A created window: the top-level Views `Window`. The `BrowserView` lives inside
/// the window delegate (dropped on window destroy).
pub(super) struct WindowEntry {
    pub(super) window: Window,
}

thread_local! {
    /// window_id -> live top-level Window. UI-thread only (Views types are not Send).
    static WINDOWS: RefCell<HashMap<u32, WindowEntry>> = RefCell::new(HashMap::new());
}

/// Record a created top-level window so later commands can find it by id.
pub fn register_window(window_id: u32, window: Window) {
    WINDOWS.with(|w| w.borrow_mut().insert(window_id, WindowEntry { window }));
}

pub(super) fn with_window<R>(window_id: u32, f: impl FnOnce(&Window) -> R) -> Option<R> {
    WINDOWS.with(|w| w.borrow().get(&window_id).map(|entry| f(&entry.window)))
}

pub(super) fn remove_window(window_id: u32) -> Option<WindowEntry> {
    WINDOWS.with(|w| w.borrow_mut().remove(&window_id))
}

pub(super) fn drain_windows() -> Vec<WindowEntry> {
    WINDOWS.with(|w| w.borrow_mut().drain().map(|(_, entry)| entry).collect())
}

/// The X11 window id (XID) backing a window's CEF Views toplevel.
pub(super) fn window_xid(window_id: u32) -> Option<u64> {
    with_window(window_id, |window| window.window_handle() as u64)
}
