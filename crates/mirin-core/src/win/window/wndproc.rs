use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GetSystemMetrics, IsZoomed, KillTimer, ScreenToClient, SetTimer, MINMAXINFO,
    NCCALCSIZE_PARAMS, SM_CXPADDEDBORDER, SM_CYSIZEFRAME, WA_INACTIVE, WM_ACTIVATE, WM_CHAR,
    WM_CLOSE, WM_DESTROY, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_GETMINMAXINFO, WM_KEYDOWN,
    WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_MOVE, WM_NCCALCSIZE, WM_NCHITTEST, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_SIZE, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

use super::controls::{emit_frame_event, resize_browser_to_client};
use super::dpi::resize_border_px;
use super::drag::{custom_hit_test, is_custom};
use super::registry;

/// Timer id used to pump CEF during the OS's modal resize/move loop.
const RESIZE_PUMP_TIMER: usize = 0x6D72; // 'mr'

/// CEF event-flag modifiers (shift/control/alt) from the current keyboard state.
fn osr_modifiers() -> u32 {
    const SHIFT: u32 = 1 << 1;
    const CONTROL: u32 = 1 << 2;
    const ALT: u32 = 1 << 3;
    let mut m = 0;
    // SAFETY: pure queries; the high bit of GetKeyState means the key is down.
    unsafe {
        if GetKeyState(VK_SHIFT as i32) < 0 {
            m |= SHIFT;
        }
        if GetKeyState(VK_CONTROL as i32) < 0 {
            m |= CONTROL;
        }
        if GetKeyState(VK_MENU as i32) < 0 {
            m |= ALT;
        }
    }
    m
}

fn lparam_xy(lparam: LPARAM) -> (i32, i32) {
    (
        (lparam & 0xFFFF) as i16 as i32,
        ((lparam >> 16) & 0xFFFF) as i16 as i32,
    )
}

/// Forward an input message into CEF for a windowless (OSR) window.
fn forward_osr_input(id: u32, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> bool {
    use crate::engine::osr;
    let mods = osr_modifiers();
    match msg {
        WM_MOUSEMOVE => {
            let (x, y) = lparam_xy(lparam);
            osr::mouse_move(id, x, y, mods, false);
        }
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
            let (x, y) = lparam_xy(lparam);
            let clicks = if msg == WM_LBUTTONDBLCLK { 2 } else { 1 };
            osr::mouse_click(id, x, y, mods, 0, false, clicks);
        }
        WM_LBUTTONUP => {
            let (x, y) = lparam_xy(lparam);
            osr::mouse_click(id, x, y, mods, 0, true, 1);
        }
        WM_RBUTTONDOWN => {
            let (x, y) = lparam_xy(lparam);
            osr::mouse_click(id, x, y, mods, 1, false, 1);
        }
        WM_RBUTTONUP => {
            let (x, y) = lparam_xy(lparam);
            osr::mouse_click(id, x, y, mods, 1, true, 1);
        }
        WM_MBUTTONDOWN => {
            let (x, y) = lparam_xy(lparam);
            osr::mouse_click(id, x, y, mods, 2, false, 1);
        }
        WM_MBUTTONUP => {
            let (x, y) = lparam_xy(lparam);
            osr::mouse_click(id, x, y, mods, 2, true, 1);
        }
        WM_MOUSEWHEEL => {
            let (sx, sy) = lparam_xy(lparam);
            let mut pt = POINT { x: sx, y: sy };
            // SAFETY: live hwnd + valid point.
            unsafe { ScreenToClient(hwnd, &mut pt) };
            let delta = ((wparam >> 16) & 0xFFFF) as i16 as i32;
            osr::mouse_wheel(id, pt.x, pt.y, 0, delta, mods);
        }
        WM_KEYDOWN | WM_SYSKEYDOWN => osr::key(id, 0, mods, wparam as i32, 0, 0, 0),
        WM_KEYUP | WM_SYSKEYUP => osr::key(id, 2, mods, wparam as i32, 0, 0, 0),
        WM_CHAR => {
            let ch = wparam as u16;
            osr::key(id, 3, mods, 0, 0, ch, ch);
        }
        _ => return false,
    }
    true
}

/// The window class's `WndProc`. Runs on the UI thread.
pub(super) unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let id = registry::window_id_for_hwnd(hwnd);

    if let Some(id) = id {
        if crate::engine::osr::is_osr_window(id) && forward_osr_input(id, hwnd, msg, wparam, lparam)
        {
            return 0;
        }
    }

    match msg {
        WM_NCCALCSIZE if wparam != 0 && id.map(is_custom).unwrap_or(false) => {
            if IsZoomed(hwnd) != 0 {
                let params = &mut *(lparam as *mut NCCALCSIZE_PARAMS);
                let fx = resize_border_px();
                let fy = GetSystemMetrics(SM_CYSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
                params.rgrc[0].left += fx;
                params.rgrc[0].top += fy;
                params.rgrc[0].right -= fx;
                params.rgrc[0].bottom -= fy;
            }
            0
        }
        WM_NCHITTEST if id.map(is_custom).unwrap_or(false) => {
            custom_hit_test(hwnd, id.unwrap(), lparam)
        }
        WM_SIZE => {
            if let Some(id) = id {
                resize_browser_to_client(id);
                emit_frame_event(id, "resized");
            }
            0
        }
        WM_GETMINMAXINFO => {
            let res = DefWindowProcW(hwnd, msg, wparam, lparam);
            if let Some(id) = id {
                if let Some((mw, mh)) = registry::min_size(id) {
                    let mmi = &mut *(lparam as *mut MINMAXINFO);
                    mmi.ptMinTrackSize.x = mmi.ptMinTrackSize.x.max(mw);
                    mmi.ptMinTrackSize.y = mmi.ptMinTrackSize.y.max(mh);
                }
            }
            res
        }
        WM_ENTERSIZEMOVE => {
            SetTimer(hwnd, RESIZE_PUMP_TIMER, 8, None);
            0
        }
        WM_TIMER if wparam == RESIZE_PUMP_TIMER as WPARAM => {
            cef::do_message_loop_work();
            0
        }
        WM_EXITSIZEMOVE => {
            KillTimer(hwnd, RESIZE_PUMP_TIMER);
            0
        }
        WM_MOVE => {
            if let Some(id) = id {
                emit_frame_event(id, "moved");
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_ACTIVATE => {
            if let Some(id) = id {
                let active = (wparam & 0xFFFF) as u32 != WA_INACTIVE;
                crate::engine::emit_window_event(id, if active { "focus" } else { "blur" });
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_CLOSE => {
            if let Some(id) = id {
                if registry::is_window_closing(id) {
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                crate::engine::request_window_close(id);
                return 0;
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_DESTROY => 0,
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
