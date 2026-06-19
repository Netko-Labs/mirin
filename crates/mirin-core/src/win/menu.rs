//! Win32 menus — the Windows analogue of `mac/menu.rs`. Builds an `HMENU` from the
//! cross-platform JSON template and pops it up; custom items (those with an `id`)
//! emit `menu.click` when chosen, exactly like macOS.
//!
//! App menu bar: macOS shows a global menu bar. Windows apps with a frameless
//! custom title bar (mirin's default) don't host a native menu bar — menus live in
//! the app's own title-bar UI — so `set_app_menu` is a deliberate no-op here.

use serde::Deserialize;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, GetForegroundWindow,
    SetForegroundWindow, TrackPopupMenu, HMENU, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR,
    MF_STRING, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON,
};

use windows_sys::Win32::Foundation::POINT;

/// Reserved command id for a `role: "quit"` item (kept out of the app's id range).
const CMD_QUIT: usize = 0xE001;
/// Base for unhandled role items, rendered but inert.
const CMD_INERT_BASE: usize = 0xF000;

/// One menu item from the TS template (same shape as macOS `MenuItemSpec`).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct MenuItemSpec {
    pub id: Option<u32>,
    pub label: Option<String>,
    /// "separator" | "submenu" | "normal" (inferred when omitted).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub role: Option<String>,
    pub accelerator: Option<String>,
    pub enabled: Option<bool>,
    pub checked: Option<bool>,
    pub submenu: Option<Vec<MenuItemSpec>>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn is_separator(item: &MenuItemSpec) -> bool {
    item.kind.as_deref() == Some("separator")
        || (item.label.is_none() && item.submenu.is_none() && item.role.is_none())
}

/// Build an `HMENU` (a popup menu) from `items`. The caller owns it and must
/// `DestroyMenu` it. `inert` is a running counter for role items we render but
/// don't route, keeping their command ids unique and out of the app's range.
fn build(items: &[MenuItemSpec], inert: &mut usize) -> HMENU {
    // SAFETY: CreatePopupMenu + AppendMenuW with valid wide strings / submenu handles.
    let menu = unsafe { CreatePopupMenu() };
    for item in items {
        if is_separator(item) {
            unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null()) };
            continue;
        }
        let label = wide(item.label.as_deref().unwrap_or(""));
        if let Some(sub) = &item.submenu {
            let submenu = build(sub, inert);
            unsafe { AppendMenuW(menu, MF_POPUP, submenu as usize, label.as_ptr()) };
            continue;
        }
        let mut flags = MF_STRING;
        if item.enabled == Some(false) {
            flags |= MF_GRAYED;
        }
        if item.checked == Some(true) {
            flags |= MF_CHECKED;
        }
        let cmd = if let Some(id) = item.id {
            id as usize
        } else if item.role.as_deref() == Some("quit") {
            CMD_QUIT
        } else {
            // A role/label item we don't route natively: render it disabled so a
            // click can't be mistaken for "nothing selected".
            flags |= MF_GRAYED;
            *inert += 1;
            CMD_INERT_BASE + *inert
        };
        unsafe { AppendMenuW(menu, flags, cmd, label.as_ptr()) };
    }
    menu
}

/// Build a popup `HMENU` from `items`. The caller owns it and must `DestroyMenu`
/// it. Used by `popup_menu` and the tray's context menu.
pub fn build_menu(items: &[MenuItemSpec]) -> HMENU {
    let mut inert = 0usize;
    build(items, &mut inert)
}

/// App menu bar — no-op on Windows (frameless title bar; the app draws its menus).
pub fn set_app_menu(_items: &[MenuItemSpec]) {}

/// Pop up a context menu at the cursor. Custom items emit `menu.click`; a
/// `role: "quit"` item quits the app. UI thread only.
pub fn popup_menu(items: &[MenuItemSpec]) {
    let menu = build_menu(items);
    // SAFETY: pure query.
    let owner = unsafe { GetForegroundWindow() };
    let cmd = track(menu, owner);
    unsafe { DestroyMenu(menu) };
    dispatch(cmd);
}

/// Show `menu` at the cursor owned by `owner`, returning the chosen command id
/// (0 = dismissed). Shared by `popup_menu` and the tray's context menu. The owner
/// must be made foreground first or the menu won't dismiss on an outside click.
pub fn track(menu: HMENU, owner: HWND) -> u32 {
    let mut pt = POINT { x: 0, y: 0 };
    // SAFETY: TPM_RETURNCMD returns the selected id synchronously.
    unsafe {
        GetCursorPos(&mut pt);
        SetForegroundWindow(owner);
        TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN,
            pt.x,
            pt.y,
            0,
            owner,
            std::ptr::null(),
        ) as u32
    }
}

/// Route a chosen menu command id to the right effect.
pub fn dispatch(cmd: u32) {
    match cmd as usize {
        0 => {}
        CMD_QUIT => crate::engine::quit(),
        id if id < CMD_INERT_BASE => {
            crate::engine::emit_event(&format!(r#"{{"type":"menu.click","id":{id}}}"#))
        }
        _ => {}
    }
}
