use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXPADDEDBORDER, SM_CXSIZEFRAME, SM_REMOTESESSION,
};

/// Opt the process into Per-Monitor-v2 DPI awareness. Call once at startup,
/// before any window or CEF init.
pub fn set_dpi_awareness() {
    // SAFETY: a one-shot process-wide setting with a constant context handle.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

/// Whether this process runs in a remote (RDP) session.
pub fn is_remote_session() -> bool {
    // SAFETY: pure query.
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

/// The resize-border thickness in physical pixels (frame + padded border).
pub(super) fn resize_border_px() -> i32 {
    // SAFETY: pure queries.
    unsafe { GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER) }
}

pub(super) fn dpi_scale(hwnd: HWND) -> f64 {
    // SAFETY: hwnd is valid; GetDpiForWindow returns 96 on failure.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}
