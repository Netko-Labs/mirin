//! mirin-owned top-level Win32 windows. CEF embeds its browser as a child HWND
//! (`WindowInfo::set_as_child`), so this module owns the frame, the window class +
//! `WndProc`, the id↔HWND registry, and resizing the CEF child to the client area.
//!
//! Custom title bar (`titleBarStyle: hidden | hiddenInset`): the window keeps its
//! native behaviors (resize, snap, min/max, shadow) but the web content fills the
//! whole window. We do this the standard Win32 way — `WM_NCCALCSIZE` removes the
//! visual non-client frame (client == window), and `WM_NCHITTEST` synthesizes the
//! resize edges and returns `HTCAPTION` over the page's `-webkit-app-region: drag`
//! areas, which gives native drag, snap, and double-click-to-maximize for free.
//!
//! Coordinates: the FFI/runtime contract documents bottom-left-origin *points*
//! (macOS). Windows is top-left *pixels*; for the MVP we treat the incoming size
//! as pixels and position from the top-left. (Full DPI scaling for `x`/`y` lands
//! with the remaining window-controls work.)

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, ScreenToClient, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::MARGINS;
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetFocus, VK_CONTROL, VK_MENU, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetCursorPos,
    GetSystemMetrics, GetWindow, GetWindowLongPtrW, GetWindowRect, IsZoomed, LoadCursorW,
    MoveWindow, PostMessageW, RegisterClassW, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos,
    SetWindowTextW, ShowWindow, CS_HREDRAW, CS_VREDRAW, GA_ROOT, GWL_STYLE, GW_CHILD, HTBOTTOM,
    HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCAPTION, HTCLIENT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
    HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, IDC_ARROW, NCCALCSIZE_PARAMS, SM_CXPADDEDBORDER,
    SM_CXSCREEN, SM_CXSIZEFRAME, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYSIZEFRAME,
    SM_CYVIRTUALSCREEN, SM_REMOTESESSION, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_FRAMECHANGED,
    SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE,
    SW_RESTORE, SW_SHOW, WA_INACTIVE, WNDCLASSW, WM_ACTIVATE, WM_CHAR, WM_CLOSE,
    WM_DESTROY, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_MOVE, WM_NCCALCSIZE, WM_NCHITTEST, WM_NCLBUTTONDOWN,
    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SIZE, WM_SYSKEYDOWN, WM_SYSKEYUP, WS_CLIPCHILDREN, WS_EX_LAYERED,
    WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_POPUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    LoadImageW, SendMessageW, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTSIZE,
    LR_LOADFROMFILE, WM_SETICON,
};
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    KillTimer, SetTimer, MINMAXINFO, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_GETMINMAXINFO, WM_TIMER,
};

/// Timer id used to pump CEF during the OS's modal resize/move loop.
const RESIZE_PUMP_TIMER: usize = 0x6D72; // 'mr'
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW;

/// The host exe's file stem (the app name) — the basis for the AppUserModelID and
/// the single-instance lock. Falls back to "App".
fn exe_file_stem() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "App".to_string())
}

/// The app's identity key for the AUMID + single-instance lock. A `mirin dev` run
/// gets a `-dev` suffix so it doesn't collide with the installed build of the same
/// app — both have the same exe name (`<App>.exe`), so without this the dev run
/// would take the installed app's mutex and exit on launch (mirrors the `-dev` CEF
/// cache dir, which already keeps their user-data separate).
fn app_key(dev: bool) -> String {
    let stem = exe_file_stem();
    if dev {
        format!("{stem}-dev")
    } else {
        stem
    }
}

/// Try to take the app's single-instance lock (a named mutex). Returns true if
/// this is the first/only instance, false if another instance already holds it.
/// The handle is intentionally leaked so the lock lives for the whole process.
pub fn acquire_single_instance(dev: bool) -> bool {
    let name: Vec<u16> = format!("Local\\mirin.{}.singleton", app_key(dev))
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: a standard named-mutex creation; we own or close the returned handle.
    unsafe {
        let h = CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr());
        if h.is_null() {
            return true; // can't create the lock — don't block startup
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(h);
            return false;
        }
        // First instance: leave the handle open (never CloseHandle) so the OS holds
        // the named mutex for the whole process lifetime.
        let _ = h;
        true
    }
}

/// Bring an already-running instance's window to the foreground (best-effort), so a
/// second launch focuses the existing app instead of doing nothing.
pub fn activate_existing_instance() {
    let class = class_name();
    // SAFETY: FindWindowW by class name; returns null when not found.
    unsafe {
        let hwnd = FindWindowW(class.as_ptr(), std::ptr::null());
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
    }
}

/// Give the process an explicit AppUserModelID so the taskbar groups this app
/// under its OWN identity and uses its window icon — instead of inheriting the
/// host runtime's (Bun's), which otherwise shows the Bun logo on the taskbar
/// button even though the window icon is correct. Derived from the exe name so
/// it's stable across versions and unique per app. Call once, early, before any
/// window is created.
pub fn set_app_id(dev: bool) {
    let id: Vec<u16> = format!("mirin.{}", app_key(dev))
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: valid null-terminated wide string; the returned HRESULT is ignorable.
    unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
}

/// Height of the fallback draggable strip (DIP) used before the page reports any
/// `-webkit-app-region` regions — mirrors the macOS overlay.
const TITLE_BAR_DRAG_HEIGHT: f64 = 38.0;

/// "hidden" | "hiddenInset" | standard, mirroring `mac::TitleBarStyle`. Both custom
/// variants render frameless on Windows (content to the edges).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBarStyle {
    Default,
    HiddenInset,
    Hidden,
}

impl TitleBarStyle {
    fn is_custom(self) -> bool {
        !matches!(self, TitleBarStyle::Default)
    }
}

/// Per-window creation options (the Windows analogue of `mac::WindowParams`).
pub struct WindowParams {
    pub id: u32,
    pub title: String,
    pub width: f64,
    pub height: f64,
    /// Minimum window size enforced via WM_GETMINMAXINFO (0 = no minimum).
    pub min_width: f64,
    pub min_height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub title_bar_style: TitleBarStyle,
    pub always_on_top: bool,
    /// Windowless (OSR) layered window — CEF paints a per-pixel-alpha frame we
    /// composite, so the window is see-through. Implies borderless.
    pub transparent: bool,
    pub show: bool,
}

/// One `-webkit-app-region` rectangle in web (DIP, top-left) coordinates.
#[derive(Clone, Copy)]
pub struct DragRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub draggable: bool,
}

thread_local! {
    /// Live mirin-owned windows, keyed by engine id → HWND (stored as `isize`).
    /// UI-thread only, where all Win32 + CEF UI work happens.
    static WINDOWS: RefCell<HashMap<u32, isize>> = RefCell::new(HashMap::new());
    /// Whether the window class has been registered (once per process).
    static CLASS_REGISTERED: RefCell<bool> = const { RefCell::new(false) };
    /// Windows whose CEF browser close has been acknowledged (`do_close` ran).
    static CLOSING: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    /// Windows with a custom (frameless) title bar.
    static CUSTOM_TITLEBARS: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    /// `-webkit-app-region` regions reported by CEF, per custom-title-bar window.
    static DRAG_REGIONS: RefCell<HashMap<u32, Vec<DragRegion>>> = RefCell::new(HashMap::new());
    /// Saved (window style, window rect) for windows in borderless fullscreen, so
    /// `control("fullscreen")` can restore them.
    static FULLSCREEN: RefCell<HashMap<u32, (isize, RECT)>> = RefCell::new(HashMap::new());
    /// Per-window minimum (width, height) in physical px, enforced via
    /// WM_GETMINMAXINFO. Only present for windows that requested a minimum.
    static MIN_SIZE: RefCell<HashMap<u32, (i32, i32)>> = RefCell::new(HashMap::new());
    /// Cached app icon HICON (`<exeDir>/icon.ico`): None = not loaded; Some(0) = no
    /// icon present; Some(h) = the loaded icon. Set per window via WM_SETICON.
    static APP_ICON: RefCell<Option<isize>> = const { RefCell::new(None) };
}

/// Load the app icon from `icon.ico` beside the host exe (placed there by the
/// bundler), cached. Used as the window icon → taskbar / Alt-Tab / title.
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

/// UTF-16, NUL-terminated — for the Win32 *W APIs.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn class_name() -> Vec<u16> {
    wide("MirinWindow")
}

fn module_handle() -> HINSTANCE {
    // SAFETY: GetModuleHandleW(NULL) returns this module's instance handle.
    unsafe { GetModuleHandleW(std::ptr::null()) }
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

/// Center a `w`×`h` window on the primary monitor.
fn center_on_primary(w: i32, h: i32) -> (i32, i32) {
    // SAFETY: pure metric queries.
    let sw = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let sh = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    (((sw - w) / 2).max(0), ((sh - h) / 2).max(0))
}

/// Keep a window's saved position usable: if `(x, y)` would put it off every
/// monitor — a stale `-32000` "minimized" marker, or a display that's since been
/// unplugged — fall back to centering on the primary monitor so it never opens
/// where the user can't see or grab it.
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
    // Require a graspable strip of the title bar to fall inside the desktop.
    const MARGIN: i32 = 48;
    let on_screen = x + w - MARGIN > vx
        && x + MARGIN < vx + vw
        && y >= vy - 8
        && y + MARGIN < vy + vh;
    if on_screen {
        (x, y)
    } else {
        center_on_primary(w, h)
    }
}

/// Create a mirin-owned top-level window registered under `id`, returning the HWND
/// (as CEF's `cef_window_handle_t`) and the client-area bounds for
/// `WindowInfo::set_as_child`. UI thread only.
pub fn create_window(params: &WindowParams) -> (*mut c_void, cef::Rect) {
    ensure_class_registered();

    // Clamp the initial size up to the minimum too (a stale/corrupt saved size
    // shouldn't open below it; WM_GETMINMAXINFO only governs interactive resizing).
    let client_w = params.width.max(params.min_width) as i32;
    let client_h = params.height.max(params.min_height) as i32;
    // Transparent windows render windowless into a layered window — borderless, and
    // their size is the content size (no frame). They don't get a custom title bar.
    let custom = !params.transparent && params.title_bar_style.is_custom();

    let style = if params.transparent {
        WS_POPUP
    } else {
        // Normal resizable top-level window — even custom-title-bar ones keep
        // WS_OVERLAPPEDWINDOW so resize/snap/min/max/shadow work; the frame is
        // removed visually via WM_NCCALCSIZE.
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN
    };
    let mut ex_style = if params.always_on_top { WS_EX_TOPMOST } else { 0 };
    if params.transparent {
        ex_style |= WS_EX_LAYERED;
    }

    // Grow the client size to the full window size (frame included) so the webview
    // gets exactly width×height. Layered windows have no frame, so they skip this.
    let (win_w, win_h) = if params.transparent {
        (client_w, client_h)
    } else {
        let mut rect = RECT {
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

    WINDOWS.with(|m| m.borrow_mut().insert(params.id, hwnd as isize));

    if params.min_width > 0.0 || params.min_height > 0.0 {
        MIN_SIZE.with(|m| {
            m.borrow_mut()
                .insert(params.id, (params.min_width as i32, params.min_height as i32));
        });
    }

    // Window icon (taskbar / Alt-Tab / title), if the bundle shipped one.
    if let Some(icon) = app_icon() {
        // SAFETY: hwnd is live; icon is a valid HICON.
        unsafe {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as WPARAM, icon as LPARAM);
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as WPARAM, icon as LPARAM);
        }
    }
    if custom {
        CUSTOM_TITLEBARS.with(|s| {
            s.borrow_mut().insert(params.id);
        });
        // Restore the window shadow on the now-frameless window (DWM draws it when
        // the frame is extended by a sliver), then force a frame recalculation so
        // WM_NCCALCSIZE removes the visual title bar.
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

    // Seed the Worker's tracked frame with the initial geometry (matches macOS).
    emit_frame_event(params.id, "moved");

    let bounds = cef::Rect {
        x: 0,
        y: 0,
        width: client_w,
        height: client_h,
    };
    (hwnd as *mut c_void, bounds)
}

/// Resize the CEF child window to fill `id`'s client area. No-op if the browser
/// child doesn't exist yet.
pub fn resize_browser_to_client(id: u32) {
    let Some(hwnd) = hwnd_for(id) else { return };
    let mut rc = empty_rect();
    // SAFETY: valid hwnd + out-param.
    unsafe { GetClientRect(hwnd, &mut rc) };
    // SAFETY: GW_CHILD returns the first child (CEF's browser window) or null.
    let child = unsafe { GetWindow(hwnd, GW_CHILD) };
    if !child.is_null() {
        // SAFETY: child is a live HWND owned by CEF.
        unsafe { MoveWindow(child, 0, 0, rc.right - rc.left, rc.bottom - rc.top, 1) };
    }
}

/// Replace the `-webkit-app-region` regions for a custom-title-bar window (from
/// CEF's DragHandler). The WndProc's hit-test consults these so window controls
/// stay clickable while declared title-bar areas drag the window.
pub fn set_draggable_regions(id: u32, regions: Vec<DragRegion>) {
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().insert(id, regions);
    });
}

/// Begin a native window-move for `id`. Called when the page reports a left
/// mousedown on a `-webkit-app-region: drag` element: the CEF child window
/// consumes mouse input, so the parent's WM_NCHITTEST never fires over the title
/// bar — the preload signals us instead (the electrobun/tao approach). Releasing
/// our capture and posting `WM_NCLBUTTONDOWN`/`HTCAPTION` hands off to Windows'
/// built-in move loop, which gives drag, edge-snapping, and double-click-maximize.
/// Start a window-move only if the viewport point `(x, y)` (CSS px, top-left) is
/// in a draggable title-bar area: inside a reported `-webkit-app-region: drag`
/// region (and no `no-drag` hole), or — before any region is reported — within the
/// fallback top strip. CEF's reported regions are in the same DIP/web coordinate
/// space as the page's mouse coords, so they compare directly.
pub fn maybe_start_drag(id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    // A resize edge/corner forwarded from the renderer (`ht` is the Win32 hit-test
    // code, e.g. HTBOTTOMRIGHT). The CEF child fills the client area, so the parent's
    // WM_NCHITTEST never sees edge hits — the preload detects edge proximity and
    // signals us, exactly like the drag. Hand straight to the OS resize loop.
    if ht != 0 {
        start_nc_drag(id, ht);
        return;
    }
    let (dx, dy) = (x as f64, y as f64);
    let draggable = DRAG_REGIONS.with(|r| {
        let map = r.borrow();
        match map.get(&id).filter(|v| !v.is_empty()) {
            Some(regions) => {
                let mut in_drag = false;
                let mut in_hole = false;
                for region in regions {
                    let inside = dx >= region.x
                        && dx <= region.x + region.w
                        && dy >= region.y
                        && dy <= region.y + region.h;
                    if inside {
                        if region.draggable {
                            in_drag = true;
                        } else {
                            in_hole = true;
                        }
                    }
                }
                in_drag && !in_hole
            }
            None => dy < TITLE_BAR_DRAG_HEIGHT,
        }
    });
    if !draggable {
        return;
    }
    // A double-click on the title bar toggles maximize (the native behavior a real
    // caption gives — lost here because we start the drag on the first mousedown).
    if detail >= 2 {
        control(id, "maximize");
    } else {
        start_nc_drag(id, HTCAPTION as i32);
    }
}

/// Hand off to Windows' built-in non-client drag loop at the current cursor with
/// hit-test `ht` — `HTCAPTION` moves the window (drag/snap/dbl-click-maximize),
/// `HTLEFT`/`HTBOTTOMRIGHT`/… resize from that edge/corner.
fn start_nc_drag(id: u32, ht: i32) {
    let Some(hwnd) = hwnd_for(id) else { return };
    let mut pt = POINT { x: 0, y: 0 };
    // SAFETY: valid out-param + live hwnd; PostMessageW is thread-safe and
    // ReleaseCapture runs on the UI thread (where this task executes).
    unsafe {
        GetCursorPos(&mut pt);
        ReleaseCapture();
        let lparam = (pt.x as i16 as u16 as isize) | ((pt.y as i16 as u16 as isize) << 16);
        PostMessageW(hwnd, WM_NCLBUTTONDOWN, ht as WPARAM, lparam);
    }
}

/// Opt the process into Per-Monitor-v2 DPI awareness so HiDPI displays render
/// crisply instead of being bitmap-scaled (the bun-compiled host ships no DPI
/// manifest). Call once at startup, before any window or CEF init. Ignored if DPI
/// awareness was already set (returns false, harmless).
pub fn set_dpi_awareness() {
    // SAFETY: a one-shot process-wide setting with a constant context handle.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

/// Whether this process runs in a remote (RDP) session, where the display adapter
/// is virtualized and CEF's GPU process crash-loops ("shared context for
/// virtualization"). Used to auto-fall-back to software rendering.
pub fn is_remote_session() -> bool {
    // SAFETY: pure query.
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

/// Set a window's caption text (the OS title bar / taskbar / Alt-Tab label).
pub fn set_window_title(id: u32, title: &str) {
    let Some(hwnd) = hwnd_for(id) else { return };
    let w = wide(title);
    // SAFETY: live hwnd; NUL-terminated wide string.
    unsafe { SetWindowTextW(hwnd, w.as_ptr()) };
}

/// Move a window's top-left origin to screen point (x, y) in pixels.
pub fn set_position(id: u32, x: f64, y: f64) {
    let Some(hwnd) = hwnd_for(id) else { return };
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

/// Apply a window control verb. Verbs mirror the macOS set (the cross-platform TS
/// API): minimize/maximize/restore/fullscreen/focus/show/hide/center/alwaysOnTop.
pub fn control(id: u32, verb: &str) {
    let Some(hwnd) = hwnd_for(id) else { return };
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
                // Toggle, matching macOS `zoom`.
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

/// Close every mirin-owned window (the `app.quit` path's fallback). Routes through
/// CEF's close — `mirin_window_close`/engine quit already handle the browsers, so
/// this just tears down any window with no live browser left.
pub fn close_all_windows() {
    let ids: Vec<u32> = WINDOWS.with(|m| m.borrow().keys().copied().collect());
    for id in ids {
        close_window(id);
    }
}

/// Monitor work-area rect for the window's current monitor.
unsafe fn monitor_rect(hwnd: HWND) -> RECT {
    let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut mi: MONITORINFO = core::mem::zeroed();
    mi.cbSize = core::mem::size_of::<MONITORINFO>() as u32;
    GetMonitorInfoW(mon, &mut mi);
    mi.rcWork
}

unsafe fn center_window(hwnd: HWND) {
    let mut wr = empty_rect();
    GetWindowRect(hwnd, &mut wr);
    let (w, h) = (wr.right - wr.left, wr.bottom - wr.top);
    let work = monitor_rect(hwnd);
    let x = work.left + ((work.right - work.left) - w) / 2;
    let y = work.top + ((work.bottom - work.top) - h) / 2;
    SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
}

unsafe fn set_topmost(hwnd: HWND, on: bool) {
    let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
    SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

/// Borderless-fullscreen toggle (Win32 has no native fullscreen): cover the whole
/// monitor, saving the style + rect to restore on the next toggle.
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
    let mut rect = empty_rect();
    GetWindowRect(hwnd, &mut rect);
    FULLSCREEN.with(|f| {
        f.borrow_mut().insert(id, (style, rect));
    });
    // Drop the resizable frame, then size to the full monitor bounds.
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

/// Emit a `window.<kind>` frame event (screen px, top-left) for the Worker's
/// frame tracking — the Windows analogue of the macOS delegate's move/resize.
fn emit_frame_event(id: u32, kind: &str) {
    let Some(hwnd) = hwnd_for(id) else { return };
    let mut r = empty_rect();
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

/// Mark `id`'s browser close as acknowledged by CEF (`do_close` ran). The next
/// WM_CLOSE on the window is allowed to destroy it (→ CEF child teardown →
/// `on_before_close`).
pub fn mark_window_closing(id: u32) {
    CLOSING.with(|s| {
        s.borrow_mut().insert(id);
    });
}

fn is_window_closing(id: u32) -> bool {
    CLOSING.with(|s| s.borrow().contains(&id))
}

fn is_custom(id: u32) -> bool {
    CUSTOM_TITLEBARS.with(|s| s.borrow().contains(&id))
}

/// Destroy the top-level window for `id` and drop it from the registries. Called
/// from `on_before_close` once CEF has torn down the browser. Idempotent.
pub fn close_window(id: u32) {
    CLOSING.with(|s| {
        s.borrow_mut().remove(&id);
    });
    CUSTOM_TITLEBARS.with(|s| {
        s.borrow_mut().remove(&id);
    });
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().remove(&id);
    });
    MIN_SIZE.with(|m| {
        m.borrow_mut().remove(&id);
    });
    if let Some(hwnd) = WINDOWS.with(|m| m.borrow_mut().remove(&id)) {
        // SAFETY: hwnd was a live top-level window we created (or already gone).
        unsafe { DestroyWindow(hwnd as HWND) };
    }
}

/// The engine id for a top-level HWND, if it's one of ours.
pub fn window_id_for_hwnd(hwnd: HWND) -> Option<u32> {
    let key = hwnd as isize;
    WINDOWS.with(|m| m.borrow().iter().find(|(_, &h)| h == key).map(|(&id, _)| id))
}

/// The engine id owning a CEF browser handle: CEF's browser HWND is a descendant
/// of our top-level window, so walk to the root and match the registry.
pub fn window_id_for_cef_handle(handle: *mut c_void) -> Option<u32> {
    if handle.is_null() {
        return None;
    }
    // SAFETY: `handle` is a live CEF child HWND; GA_ROOT returns its top-level owner.
    let root = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetAncestor(handle as HWND, GA_ROOT) };
    window_id_for_hwnd(root)
}

pub(crate) fn hwnd_for(id: u32) -> Option<HWND> {
    WINDOWS.with(|m| m.borrow().get(&id).map(|&h| h as HWND))
}

fn empty_rect() -> RECT {
    RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    }
}

/// The resize-border thickness in physical pixels (frame + padded border).
fn resize_border_px() -> i32 {
    // SAFETY: pure queries.
    unsafe { GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER) }
}

fn dpi_scale(hwnd: HWND) -> f64 {
    // SAFETY: hwnd is valid; GetDpiForWindow returns 96 on failure.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

/// Whether a client-space point (physical px) lies in a draggable title-bar area:
/// inside a reported `-webkit-app-region: drag` region (and no `no-drag` hole), or
/// — before any region is reported — within the fallback top strip.
fn point_is_draggable(id: u32, px: i32, py: i32, scale: f64, client_h: i32) -> bool {
    let _ = client_h;
    DRAG_REGIONS.with(|r| {
        let map = r.borrow();
        match map.get(&id).filter(|v| !v.is_empty()) {
            Some(regions) => {
                let (dx, dy) = (px as f64 / scale, py as f64 / scale);
                let mut in_drag = false;
                let mut in_hole = false;
                for region in regions {
                    let inside = dx >= region.x
                        && dx <= region.x + region.w
                        && dy >= region.y
                        && dy <= region.y + region.h;
                    if inside {
                        if region.draggable {
                            in_drag = true;
                        } else {
                            in_hole = true;
                        }
                    }
                }
                in_drag && !in_hole
            }
            // No app-regions yet: behave like a blanket top strip.
            None => (py as f64) < TITLE_BAR_DRAG_HEIGHT * scale,
        }
    })
}

/// Hit-test a custom-title-bar window: synthesize resize edges/corners, then return
/// `HTCAPTION` over draggable title-bar areas (native drag + snap + dbl-click max),
/// else `HTCLIENT` so the click reaches the webview. `lparam` carries screen coords.
fn custom_hit_test(hwnd: HWND, id: u32, lparam: LPARAM) -> LRESULT {
    let mut pt = POINT {
        x: (lparam & 0xFFFF) as i16 as i32,
        y: ((lparam >> 16) & 0xFFFF) as i16 as i32,
    };
    // SAFETY: valid hwnd + point.
    unsafe { ScreenToClient(hwnd, &mut pt) };
    let mut rc = empty_rect();
    // SAFETY: valid hwnd + out-param.
    unsafe { GetClientRect(hwnd, &mut rc) };
    let (cw, ch) = (rc.right - rc.left, rc.bottom - rc.top);

    // Maximized windows can't be edge-resized.
    // SAFETY: pure query.
    let maximized = unsafe { IsZoomed(hwnd) } != 0;
    if !maximized {
        let b = resize_border_px();
        let left = pt.x < b;
        let right = pt.x >= cw - b;
        let top = pt.y < b;
        let bottom = pt.y >= ch - b;
        let edge = match (top, bottom, left, right) {
            (true, _, true, _) => Some(HTTOPLEFT),
            (true, _, _, true) => Some(HTTOPRIGHT),
            (_, true, true, _) => Some(HTBOTTOMLEFT),
            (_, true, _, true) => Some(HTBOTTOMRIGHT),
            (true, ..) => Some(HTTOP),
            (_, true, ..) => Some(HTBOTTOM),
            (_, _, true, _) => Some(HTLEFT),
            (_, _, _, true) => Some(HTRIGHT),
            _ => None,
        };
        if let Some(edge) = edge {
            return edge as LRESULT;
        }
    }

    let scale = dpi_scale(hwnd);
    if point_is_draggable(id, pt.x, pt.y, scale, ch) {
        HTCAPTION as LRESULT
    } else {
        HTCLIENT as LRESULT
    }
}

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

/// Forward an input message into CEF for a windowless (OSR) window — there's no
/// child window to receive it. Returns true if it was an input message we handled.
/// CEF key-event type codes: 0 = RAWKEYDOWN, 2 = KEYUP, 3 = CHAR (`engine::osr`).
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
            // WM_MOUSEWHEEL coords are screen → convert to client.
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

/// The window class's `WndProc`. Runs on the UI thread (the CEF message loop pumps
/// Win32 messages on the same thread), so calling into the engine/CEF here is safe.
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let id = window_id_for_hwnd(hwnd);

    // Windowless (transparent) windows: forward input into CEF (no child window).
    if let Some(id) = id {
        if crate::engine::osr::is_osr_window(id) && forward_osr_input(id, hwnd, msg, wparam, lparam) {
            return 0;
        }
    }

    match msg {
        // Custom title bar: client area == whole window (no visual frame). For a
        // maximized window, inset by the frame so content fits the work area and
        // doesn't spill under the taskbar.
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
        // The OS modal resize/move loop blocks our CEF message loop, which freezes
        // the page until release (ugly). Pump CEF on a fast timer for the duration
        // of the loop so the content resizes live; the WM_SIZE above keeps the CEF
        // child sized to the client.
        // Enforce the window's minimum size (so it can't be resized too small).
        WM_GETMINMAXINFO => {
            let res = DefWindowProcW(hwnd, msg, wparam, lparam);
            if let Some(id) = id {
                if let Some((mw, mh)) = MIN_SIZE.with(|m| m.borrow().get(&id).copied()) {
                    // SAFETY: lparam is a live MINMAXINFO during WM_GETMINMAXINFO.
                    let mmi = &mut *(lparam as *mut MINMAXINFO);
                    mmi.ptMinTrackSize.x = mmi.ptMinTrackSize.x.max(mw);
                    mmi.ptMinTrackSize.y = mmi.ptMinTrackSize.y.max(mh);
                }
            }
            res
        }
        WM_ENTERSIZEMOVE => {
            SetTimer(hwnd, RESIZE_PUMP_TIMER, 8, None); // ~120 Hz
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
            // CEF set_as_child close dance (see win/mod.rs). First WM_CLOSE → ask
            // CEF to close, cancel destroy. Once acknowledged (`do_close` marked the
            // window closing), let DefWindowProc destroy → CEF child teardown →
            // `on_before_close`.
            if let Some(id) = id {
                if is_window_closing(id) {
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
