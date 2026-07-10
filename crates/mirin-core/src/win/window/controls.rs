use std::cell::RefCell;

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, GetClientRect, GetWindow, GetWindowLongPtrW, GetWindowRect, IsZoomed,
    MoveWindow, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow,
    GWL_STYLE, GW_CHILD, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOMOVE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
    SW_SHOW, WS_OVERLAPPEDWINDOW,
};

use super::create::wide;
use super::drag::clear_custom_titlebar;
use super::registry;

thread_local! {
    /// Saved (window style, window rect) for windows in borderless fullscreen.
    static FULLSCREEN: RefCell<std::collections::HashMap<u32, (isize, RECT)>> =
        RefCell::new(std::collections::HashMap::new());
}

/// Resize the CEF child window to fill `id`'s client area.
pub fn resize_browser_to_client(id: u32) {
    let Some(hwnd) = registry::hwnd_for(id) else {
        return;
    };
    let mut rc = registry::empty_rect();
    // SAFETY: valid hwnd + out-param.
    unsafe { GetClientRect(hwnd, &mut rc) };
    // SAFETY: GW_CHILD returns the first child (CEF's browser window) or null.
    let child = unsafe { GetWindow(hwnd, GW_CHILD) };
    if !child.is_null() {
        // SAFETY: child is a live HWND owned by CEF.
        unsafe { MoveWindow(child, 0, 0, rc.right - rc.left, rc.bottom - rc.top, 1) };
    }
}

/// Set a window's caption text (the OS title bar / taskbar / Alt-Tab label).
pub fn set_window_title(id: u32, title: &str) {
    let Some(hwnd) = registry::hwnd_for(id) else {
        return;
    };
    let w = wide(title);
    // SAFETY: live hwnd; NUL-terminated wide string.
    unsafe { SetWindowTextW(hwnd, w.as_ptr()) };
}

/// Move a window's top-left origin to screen point (x, y) in pixels.
pub fn set_position(id: u32, x: f64, y: f64) {
    let Some(hwnd) = registry::hwnd_for(id) else {
        return;
    };
    // SAFETY: live hwnd.
    unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x as i32,
            y as i32,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER,
        )
    };
}

/// Apply a window control verb.
pub fn control(id: u32, verb: &str) {
    let Some(hwnd) = registry::hwnd_for(id) else {
        return;
    };
    // SAFETY: each call targets the live top-level hwnd.
    unsafe {
        match verb {
            "minimize" => {
                ShowWindow(hwnd, SW_MINIMIZE);
            }
            "restore" => {
                ShowWindow(hwnd, SW_RESTORE);
            }
            "maximize" => {
                if IsZoomed(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                } else {
                    ShowWindow(hwnd, SW_MAXIMIZE);
                }
            }
            "fullscreen" => toggle_fullscreen(id, hwnd),
            "focus" | "show" => {
                ShowWindow(hwnd, SW_SHOW);
                SetForegroundWindow(hwnd);
                SetFocus(hwnd);
            }
            "hide" => {
                ShowWindow(hwnd, SW_HIDE);
            }
            "center" => center_window(hwnd),
            "alwaysOnTop:on" => set_topmost(hwnd, true),
            "alwaysOnTop:off" => set_topmost(hwnd, false),
            _ => {}
        }
    }
}

/// Close every mirin-owned window.
pub fn close_all_windows() {
    let ids = registry::window_ids();
    for id in ids {
        close_window(id);
    }
}

unsafe fn monitor_rect(hwnd: HWND) -> RECT {
    let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut mi: MONITORINFO = core::mem::zeroed();
    mi.cbSize = core::mem::size_of::<MONITORINFO>() as u32;
    GetMonitorInfoW(mon, &mut mi);
    mi.rcWork
}

unsafe fn center_window(hwnd: HWND) {
    let mut wr = registry::empty_rect();
    GetWindowRect(hwnd, &mut wr);
    let (w, h) = (wr.right - wr.left, wr.bottom - wr.top);
    let work = monitor_rect(hwnd);
    let x = work.left + ((work.right - work.left) - w) / 2;
    let y = work.top + ((work.bottom - work.top) - h) / 2;
    SetWindowPos(
        hwnd,
        std::ptr::null_mut(),
        x,
        y,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER,
    );
}

unsafe fn set_topmost(hwnd: HWND, on: bool) {
    let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
    SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

/// Borderless-fullscreen toggle.
unsafe fn toggle_fullscreen(id: u32, hwnd: HWND) {
    let saved = FULLSCREEN.with(|f| f.borrow_mut().remove(&id));
    if let Some((style, rect)) = saved {
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOZORDER | SWP_FRAMECHANGED,
        );
        return;
    }
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    let mut rect = registry::empty_rect();
    GetWindowRect(hwnd, &mut rect);
    FULLSCREEN.with(|f| {
        f.borrow_mut().insert(id, (style, rect));
    });
    let bare = style & !(WS_OVERLAPPEDWINDOW as isize);
    SetWindowLongPtrW(hwnd, GWL_STYLE, bare);
    let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut mi: MONITORINFO = core::mem::zeroed();
    mi.cbSize = core::mem::size_of::<MONITORINFO>() as u32;
    GetMonitorInfoW(mon, &mut mi);
    let m = mi.rcMonitor;
    SetWindowPos(
        hwnd,
        HWND_TOP,
        m.left,
        m.top,
        m.right - m.left,
        m.bottom - m.top,
        SWP_NOOWNERZORDER | SWP_FRAMECHANGED,
    );
}

/// Emit a `window.<kind>` frame event for the Worker's frame tracking.
pub(super) fn emit_frame_event(id: u32, kind: &str) {
    let Some(hwnd) = registry::hwnd_for(id) else {
        return;
    };
    let mut r = registry::empty_rect();
    // SAFETY: live hwnd + out-param.
    let maximized = unsafe {
        GetWindowRect(hwnd, &mut r);
        IsZoomed(hwnd) != 0
    };
    crate::engine::emit_window_frame(
        id,
        kind,
        r.left as f64,
        r.top as f64,
        (r.right - r.left) as f64,
        (r.bottom - r.top) as f64,
        maximized,
    );
}

/// Destroy the top-level window for `id` and drop it from the registries.
pub fn close_window(id: u32) {
    registry::clear_window_closing(id);
    clear_custom_titlebar(id);
    registry::remove_min_size(id);
    if let Some(hwnd) = registry::remove_window(id) {
        // SAFETY: hwnd was a live top-level window we created (or already gone).
        unsafe { DestroyWindow(hwnd) };
    }
}
