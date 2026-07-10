use std::cell::RefCell;
use std::ffi::c_void;

use windows_sys::Win32::Foundation::HINSTANCE;
use windows_sys::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::MARGINS;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, CreateWindowExW, GetSystemMetrics, LoadCursorW, LoadImageW, RegisterClassW,
    SendMessageW, SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, HICON, ICON_BIG, ICON_SMALL,
    IDC_ARROW, IMAGE_ICON, LR_DEFAULTSIZE, LR_LOADFROMFILE, SM_CXSCREEN, SM_CXVIRTUALSCREEN,
    SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_FRAMECHANGED,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOW, WM_SETICON, WNDCLASSW, WS_CLIPCHILDREN,
    WS_EX_LAYERED, WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_POPUP,
};

use super::controls::emit_frame_event;
use super::drag::mark_custom_titlebar;
use super::registry;
use super::types::WindowParams;
use super::wndproc::wndproc;

thread_local! {
    /// Whether the window class has been registered (once per process).
    static CLASS_REGISTERED: RefCell<bool> = const { RefCell::new(false) };
    /// Cached app icon HICON (`<exeDir>/icon.ico`): None = not loaded; Some(0) =
    /// no icon present; Some(h) = the loaded icon.
    static APP_ICON: RefCell<Option<isize>> = const { RefCell::new(None) };
}

/// UTF-16, NUL-terminated, for the Win32 *W APIs.
pub(super) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(super) fn class_name() -> Vec<u16> {
    wide("MirinWindow")
}

pub(super) fn module_handle() -> HINSTANCE {
    // SAFETY: GetModuleHandleW(NULL) returns this module's instance handle.
    unsafe { GetModuleHandleW(std::ptr::null()) }
}

/// Load the app icon from `icon.ico` beside the host exe (placed there by the
/// bundler), cached. Used as the window icon -> taskbar / Alt-Tab / title.
fn app_icon() -> Option<HICON> {
    if let Some(cached) = APP_ICON.with(|i| *i.borrow()) {
        return (cached != 0).then_some(cached as HICON);
    }
    let icon = std::env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name("icon.ico"))
        .filter(|p| p.exists())
        .and_then(|p| p.to_str().map(wide))
        .and_then(|path| {
            // SAFETY: loading an icon from a file path; LR_DEFAULTSIZE picks a size.
            let h = unsafe {
                LoadImageW(
                    std::ptr::null_mut(),
                    path.as_ptr(),
                    IMAGE_ICON,
                    0,
                    0,
                    LR_LOADFROMFILE | LR_DEFAULTSIZE,
                )
            };
            (!h.is_null()).then_some(h as HICON)
        });
    APP_ICON.with(|i| *i.borrow_mut() = Some(icon.map_or(0, |h| h as isize)));
    icon
}

/// Register the mirin window class once. Idempotent.
fn ensure_class_registered() {
    if CLASS_REGISTERED.with(|r| *r.borrow()) {
        return;
    }
    let name = class_name();
    let wc = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: module_handle(),
        hIcon: std::ptr::null_mut(),
        // SAFETY: standard system cursor, no ownership to manage.
        hCursor: unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) },
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: name.as_ptr(),
    };
    // SAFETY: `wc` + its class name outlive this call.
    unsafe { RegisterClassW(&wc) };
    CLASS_REGISTERED.with(|r| *r.borrow_mut() = true);
}

/// Center a `w`x`h` window on the primary monitor.
fn center_on_primary(w: i32, h: i32) -> (i32, i32) {
    // SAFETY: pure metric queries.
    let sw = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let sh = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    (((sw - w) / 2).max(0), ((sh - h) / 2).max(0))
}

/// Keep a window's saved position usable; if it is off every monitor, fall back
/// to the primary monitor center.
fn clamp_on_screen(x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    // SAFETY: pure metric queries (virtual screen = the union of all monitors).
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    const MARGIN: i32 = 48;
    let on_screen =
        x + w - MARGIN > vx && x + MARGIN < vx + vw && y >= vy - 8 && y + MARGIN < vy + vh;
    if on_screen {
        (x, y)
    } else {
        center_on_primary(w, h)
    }
}

/// Create a mirin-owned top-level window registered under `id`, returning the
/// HWND and the client-area bounds for `WindowInfo::set_as_child`. UI thread only.
pub fn create_window(params: &WindowParams) -> (*mut c_void, cef::Rect) {
    ensure_class_registered();

    let client_w = params.width.max(params.min_width) as i32;
    let client_h = params.height.max(params.min_height) as i32;
    let custom = !params.transparent && params.title_bar_style.is_custom();

    let style = if params.transparent {
        WS_POPUP
    } else {
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN
    };
    let mut ex_style = if params.always_on_top {
        WS_EX_TOPMOST
    } else {
        0
    };
    if params.transparent {
        ex_style |= WS_EX_LAYERED;
    }

    let (win_w, win_h) = if params.transparent {
        (client_w, client_h)
    } else {
        let mut rect = windows_sys::Win32::Foundation::RECT {
            left: 0,
            top: 0,
            right: client_w,
            bottom: client_h,
        };
        // SAFETY: valid out-param; style/ex_style match the create call.
        unsafe { AdjustWindowRectEx(&mut rect, style, 0, ex_style) };
        (rect.right - rect.left, rect.bottom - rect.top)
    };

    let (x, y) = match (params.x, params.y) {
        (Some(x), Some(y)) => clamp_on_screen(x as i32, y as i32, win_w, win_h),
        _ => center_on_primary(win_w, win_h),
    };

    let title = wide(&params.title);
    let name = class_name();
    // SAFETY: class registered; wide strings outlive the call; null parent/menu/param.
    let hwnd = unsafe {
        CreateWindowExW(
            ex_style,
            name.as_ptr(),
            title.as_ptr(),
            style,
            x,
            y,
            win_w,
            win_h,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            module_handle(),
            std::ptr::null(),
        )
    };
    assert!(!hwnd.is_null(), "CreateWindowExW failed");

    registry::register_window(params.id, hwnd);

    if params.min_width > 0.0 || params.min_height > 0.0 {
        registry::set_min_size(params.id, params.min_width as i32, params.min_height as i32);
    }

    if let Some(icon) = app_icon() {
        // SAFETY: hwnd is live; icon is a valid HICON.
        unsafe {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, icon as isize);
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
        }
    }
    if custom {
        mark_custom_titlebar(params.id);
        let margins = MARGINS {
            cxLeftWidth: 0,
            cxRightWidth: 0,
            cyTopHeight: 1,
            cyBottomHeight: 0,
        };
        // SAFETY: hwnd is live; margins valid for the call.
        unsafe {
            DwmExtendFrameIntoClientArea(hwnd, &margins);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
            );
        }
    }

    if params.show {
        // SAFETY: hwnd is valid.
        unsafe { ShowWindow(hwnd, SW_SHOW) };
    }

    emit_frame_event(params.id, "moved");

    let bounds = cef::Rect {
        x: 0,
        y: 0,
        width: client_w,
        height: client_h,
    };
    (hwnd as *mut c_void, bounds)
}
