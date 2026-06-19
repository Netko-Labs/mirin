//! System-tray icon via `Shell_NotifyIcon` — the Windows analogue of
//! `mac/tray.rs` (`NSStatusItem`). A message-only window receives the icon's
//! callback; a click shows the configured context menu (custom items emit
//! `menu.click`) or, if there's no menu, emits `tray.click`.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Deserialize;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyMenu, LoadIconW, RegisterClassW, HWND_MESSAGE,
    IDI_APPLICATION, WM_LBUTTONUP, WM_RBUTTONUP, WNDCLASSW,
};

use crate::win::menu::{self, MenuItemSpec};

/// Tray icon callback message (WM_APP + 1).
const TRAY_CALLBACK: u32 = 0x8000 + 1;

#[derive(Deserialize)]
struct TraySpec {
    id: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tooltip: Option<String>,
    #[serde(default)]
    menu: Option<Vec<MenuItemSpec>>,
}

thread_local! {
    /// The message-only window that owns the tray callbacks (UI thread).
    static TRAY_WINDOW: RefCell<Option<isize>> = const { RefCell::new(None) };
    /// Per-tray context menu templates, shown on click.
    static MENUS: RefCell<HashMap<u32, Vec<MenuItemSpec>>> = RefCell::new(HashMap::new());
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn tray_window() -> HWND {
    if let Some(h) = TRAY_WINDOW.with(|w| *w.borrow()) {
        return h as HWND;
    }
    let name = wide("MirinTrayWindow");
    // SAFETY: standard class registration + message-only window.
    let hwnd = unsafe {
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(tray_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: name.as_ptr(),
        };
        RegisterClassW(&wc);
        CreateWindowExW(
            0,
            name.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    TRAY_WINDOW.with(|w| *w.borrow_mut() = Some(hwnd as isize));
    hwnd
}

fn base_data(id: u32) -> NOTIFYICONDATAW {
    // SAFETY: NOTIFYICONDATAW is plain-old-data; zeroing then setting the fields we
    // use is the documented pattern.
    let mut data: NOTIFYICONDATAW = unsafe { core::mem::zeroed() };
    data.cbSize = core::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = tray_window();
    data.uID = id;
    data
}

/// Create (or replace) a tray icon from the JSON spec `{ id, title?, tooltip?, menu? }`.
pub fn create(json: &str) {
    let Ok(spec) = serde_json::from_str::<TraySpec>(json) else {
        return;
    };
    let mut data = base_data(spec.id);
    data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    data.uCallbackMessage = TRAY_CALLBACK;
    // No per-tray icon in the cross-platform spec yet → use the default app icon.
    // SAFETY: IDI_APPLICATION is a shared system icon.
    data.hIcon = unsafe { LoadIconW(std::ptr::null_mut(), IDI_APPLICATION) };

    let tip = spec.tooltip.or(spec.title).unwrap_or_default();
    for (i, c) in tip.encode_utf16().take(data.szTip.len() - 1).enumerate() {
        data.szTip[i] = c;
    }

    // SAFETY: data is fully initialized and lives across the call.
    unsafe { Shell_NotifyIconW(NIM_ADD, &data) };

    MENUS.with(|m| {
        let mut m = m.borrow_mut();
        match spec.menu {
            Some(items) => {
                m.insert(spec.id, items);
            }
            None => {
                m.remove(&spec.id);
            }
        }
    });
}

/// Remove a tray icon.
pub fn destroy(id: u32) {
    let data = base_data(id);
    // SAFETY: NIM_DELETE only reads hWnd + uID.
    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
    MENUS.with(|m| {
        m.borrow_mut().remove(&id);
    });
}

/// Tray callback: lParam's low word is the mouse message; a left/right click shows
/// the context menu (if any) or emits `tray.click`.
unsafe extern "system" fn tray_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == TRAY_CALLBACK {
        let mouse = (lparam & 0xFFFF) as u32;
        if mouse == WM_RBUTTONUP || mouse == WM_LBUTTONUP {
            let id = wparam as u32;
            let items = MENUS.with(|m| m.borrow().get(&id).cloned());
            match items {
                Some(items) => {
                    let menu = menu::build_menu(&items);
                    let cmd = menu::track(menu, hwnd);
                    DestroyMenu(menu);
                    menu::dispatch(cmd);
                }
                None => {
                    crate::engine::emit_event(&format!(r#"{{"type":"tray.click","id":{id}}}"#));
                }
            }
        }
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
