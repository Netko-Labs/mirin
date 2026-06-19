//! Win32 clipboard text access (CF_UNICODETEXT) — the Windows analogue of
//! `mac/clipboard.rs`. Called from the Worker thread; the system clipboard is
//! process-global and each call is short and self-contained.

use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

/// Read the clipboard's Unicode text, or None if empty / not text.
pub fn read_text() -> Option<String> {
    // SAFETY: standard OpenClipboard → Get → Lock/Unlock → CloseClipboard sequence;
    // every handle is checked before use and the clipboard is always closed.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let result = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT as u32);
            if handle.is_null() {
                return None;
            }
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            GlobalUnlock(handle);
            Some(text)
        })();
        CloseClipboard();
        result
    }
}

/// Replace the clipboard contents with `text` (CF_UNICODETEXT).
pub fn write_text(text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();
    // SAFETY: a moveable HGLOBAL is allocated, filled with the NUL-terminated wide
    // string, and ownership is transferred to the clipboard via SetClipboardData.
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return;
        }
        EmptyClipboard();
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if !handle.is_null() {
            let dst = GlobalLock(handle) as *mut u16;
            if !dst.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                GlobalUnlock(handle);
                SetClipboardData(CF_UNICODETEXT as u32, handle);
            }
        }
        CloseClipboard();
    }
}
