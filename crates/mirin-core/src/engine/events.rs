use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::{c_char, CString};
use std::sync::Mutex;

/// Events are buffered here and drained by the Worker via `mirin_poll_event`.
/// We poll rather than use a bun:ffi threadsafe callback: the host's main thread
/// is blocked inside `mirin_run` (the CEF loop), and a callback invoked from it
/// does not reach the Worker's event loop.
static EVENT_QUEUE: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

thread_local! {
    /// Holds the most recently polled event so its C string stays valid until
    /// the next poll (the Worker copies it out synchronously before polling again).
    static CURRENT_EVENT: RefCell<Option<CString>> = const { RefCell::new(None) };
}

/// Queue a JSON event for the Worker to drain.
pub fn emit_event(json: &str) {
    // Recover from a poisoned lock instead of panicking: with `panic = "abort"`
    // an `.expect()` here would take the whole process down over a transient
    // poison on the hottest path in the engine.
    EVENT_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push_back(json.to_string());
}

/// Queue a `window.<kind>` event for `id` (focus/blur/moved/resized/...).
pub fn emit_window_event(id: u32, kind: &str) {
    emit_event(&format!(r#"{{"type":"window.{kind}","id":{id}}}"#));
}

/// Queue a `window.<kind>` event carrying the window's frame + maximized state.
/// Frame coordinates are screen points with a bottom-left origin.
pub fn emit_window_frame(id: u32, kind: &str, x: f64, y: f64, w: f64, h: f64, maximized: bool) {
    emit_event(&format!(
        r#"{{"type":"window.{kind}","id":{id},"frame":{{"x":{x},"y":{y},"width":{w},"height":{h}}},"maximized":{maximized}}}"#
    ));
}

/// Pop the next queued event as a C string (valid until the next call), or null.
pub fn poll_event() -> *const c_char {
    let next = EVENT_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pop_front();
    match next {
        Some(json) => {
            let cstr = CString::new(json).unwrap_or_default();
            let ptr = cstr.as_ptr();
            CURRENT_EVENT.with(|c| *c.borrow_mut() = Some(cstr));
            ptr
        }
        None => std::ptr::null(),
    }
}
