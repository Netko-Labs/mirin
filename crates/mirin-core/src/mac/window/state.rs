use objc2::{msg_send, rc::Retained, runtime::AnyObject};
use objc2_app_kit::NSWindow;
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    /// Live mirin-owned windows, keyed by engine-assigned id. Main-thread only
    /// (NSWindow is not Send), which is where all AppKit/CEF UI work happens.
    static WINDOWS: RefCell<HashMap<u32, Retained<NSWindow>>> = RefCell::new(HashMap::new());
}

/// Run `f` with the live NSWindow for `id`, if present. Main thread only.
pub fn with_window<R>(id: u32, f: impl FnOnce(&NSWindow) -> R) -> Option<R> {
    WINDOWS.with(|w| w.borrow().get(&id).map(|win| f(win)))
}

pub(super) fn register_window(id: u32, window: Retained<NSWindow>) {
    WINDOWS.with(|w| {
        w.borrow_mut().insert(id, window);
    });
}

pub(super) fn remove_window(id: u32) -> Option<Retained<NSWindow>> {
    WINDOWS.with(|w| w.borrow_mut().remove(&id))
}

pub(super) fn drain_windows() -> Vec<Retained<NSWindow>> {
    WINDOWS.with(|w| w.borrow_mut().drain().map(|(_, win)| win).collect())
}

/// Find the registry id of the window hosting the given NSView (CEF's browser
/// view), by matching the view's NSWindow against the registry.
pub fn window_id_for_view(view: *mut std::ffi::c_void) -> Option<u32> {
    let view = view as *mut AnyObject;
    let view = unsafe { view.as_ref() }?;
    let window: *mut AnyObject = unsafe { msg_send![view, window] };
    if window.is_null() {
        return None;
    }
    WINDOWS.with(|w| {
        w.borrow()
            .iter()
            .find(|(_, win)| Retained::as_ptr(win) as *mut AnyObject == window)
            .map(|(id, _)| *id)
    })
}
