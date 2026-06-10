//! Clipboard commands. Text-only for the MVP. Accessed from the Worker thread
//! directly (NSPasteboard text access is fine off the main thread in practice).

use std::cell::RefCell;
use std::ffi::{c_char, CString};

thread_local! {
    /// Keeps the last read string alive until the next read (the Worker copies
    /// it out synchronously).
    static LAST_READ: RefCell<Option<CString>> = const { RefCell::new(None) };
}

pub fn clipboard_read_text() -> *const c_char {
    #[cfg(target_os = "macos")]
    {
        let text = crate::mac::clipboard::read_text().unwrap_or_default();
        let cstr = CString::new(text).unwrap_or_default();
        let ptr = cstr.as_ptr();
        LAST_READ.with(|s| *s.borrow_mut() = Some(cstr));
        return ptr;
    }
    #[allow(unreachable_code)]
    std::ptr::null()
}

pub fn clipboard_write_text(text: String) {
    #[cfg(target_os = "macos")]
    crate::mac::clipboard::write_text(&text);
    #[cfg(not(target_os = "macos"))]
    let _ = text;
}
