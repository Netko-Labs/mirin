//! Global keyboard shortcuts via Win32 `RegisterHotKey` — the Windows analogue of
//! `mac/shortcut.rs` (Carbon). Registration runs on the UI thread; presses arrive
//! as `WM_HOTKEY` on a message-only window we own, whose WndProc emits a
//! `shortcut.trigger` event (the same shape macOS emits).

use std::cell::RefCell;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassW, HWND_MESSAGE, WM_HOTKEY, WNDCLASSW,
};

thread_local! {
    /// The message-only window that owns the hotkey registrations (UI thread).
    static HOTKEY_WINDOW: RefCell<Option<isize>> = const { RefCell::new(None) };
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Lazily create the message-only window that receives `WM_HOTKEY`. UI thread.
fn hotkey_window() -> HWND {
    if let Some(h) = HOTKEY_WINDOW.with(|w| *w.borrow()) {
        return h as HWND;
    }
    let name = wide("MirinShortcutWindow");
    // SAFETY: standard class registration + message-only window creation.
    let hwnd = unsafe {
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(hotkey_proc),
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
    HOTKEY_WINDOW.with(|w| *w.borrow_mut() = Some(hwnd as isize));
    hwnd
}

/// `WM_HOTKEY`'s wParam is the hotkey id we registered → emit `shortcut.trigger`.
unsafe extern "system" fn hotkey_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_HOTKEY {
        crate::engine::emit_event(&format!(
            r#"{{"type":"shortcut.trigger","id":{}}}"#,
            wparam as u32
        ));
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Parse "Cmd+Shift+K" into (Win32 modifier mask, virtual-key code). `Cmd`/`Super`/
/// `Meta` map to Ctrl (the cross-platform convention; mapping to the Windows key
/// would collide with the OS). Returns None if the key isn't recognized.
pub fn parse(accelerator: &str) -> Option<(u32, u32)> {
    let mut modifiers = MOD_NOREPEAT;
    let mut vk = None;
    for part in accelerator.split('+') {
        match part.trim().to_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" | "ctrl" | "control" | "commandorcontrol" => {
                modifiers |= MOD_CONTROL
            }
            "win" | "windows" => modifiers |= MOD_WIN,
            "shift" => modifiers |= MOD_SHIFT,
            "alt" | "option" => modifiers |= MOD_ALT,
            other => vk = vk_for(other),
        }
    }
    vk.map(|code| (modifiers, code))
}

pub fn register(id: u32, accelerator: &str) -> bool {
    let Some((modifiers, vk)) = parse(accelerator) else {
        return false;
    };
    let hwnd = hotkey_window();
    // SAFETY: hwnd is our live message window; id is the engine shortcut id.
    unsafe { RegisterHotKey(hwnd, id as i32, modifiers, vk) != 0 }
}

pub fn unregister(id: u32) {
    let hwnd = hotkey_window();
    // SAFETY: hwnd is our live message window.
    unsafe { UnregisterHotKey(hwnd, id as i32) };
}

/// Windows virtual-key code for an accelerator key token.
fn vk_for(key: &str) -> Option<u32> {
    // Single ASCII letter/digit → its VK is the uppercase ASCII code.
    if key.len() == 1 {
        let c = key.as_bytes()[0];
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase() as u32);
        }
        if c.is_ascii_digit() {
            return Some(c as u32);
        }
    }
    let vk = match key {
        "=" => 0xBB,  // VK_OEM_PLUS
        "-" => 0xBD,  // VK_OEM_MINUS
        "," => 0xBC,  // VK_OEM_COMMA
        "." => 0xBE,  // VK_OEM_PERIOD
        ";" => 0xBA,  // VK_OEM_1
        "/" => 0xBF,  // VK_OEM_2
        "`" => 0xC0,  // VK_OEM_3
        "[" => 0xDB,  // VK_OEM_4
        "\\" => 0xDC, // VK_OEM_5
        "]" => 0xDD,  // VK_OEM_6
        "'" => 0xDE,  // VK_OEM_7
        "return" | "enter" => 0x0D,
        "tab" => 0x09,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" => 0x2E,
        "escape" | "esc" => 0x1B,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "f1" => 0x70,
        "f2" => 0x71,
        "f3" => 0x72,
        "f4" => 0x73,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        "f8" => 0x77,
        "f9" => 0x78,
        "f10" => 0x79,
        "f11" => 0x7A,
        "f12" => 0x7B,
        _ => return None,
    };
    Some(vk)
}
