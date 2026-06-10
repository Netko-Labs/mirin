//! Global keyboard shortcuts via Carbon `RegisterEventHotKey` — works
//! system-wide without the accessibility permission an NSEvent global monitor
//! would require. Registration runs on the main (UI) thread; the Carbon handler
//! fires there too and emits a `shortcut.trigger` event.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[allow(non_camel_case_types)]
type OSStatus = i32;
type EventRef = *mut c_void;
type EventHandlerCallRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHotKeyRef = *mut c_void;
type EventHandlerUPP = extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct EventHotKeyID {
    signature: u32,
    id: u32,
}

const fn fourcc(b: &[u8; 4]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
}

const K_EVENT_CLASS_KEYBOARD: u32 = fourcc(b"keyb");
const K_EVENT_HOTKEY_PRESSED: u32 = 6;
const K_EVENT_PARAM_DIRECT_OBJECT: u32 = fourcc(b"----");
const TYPE_EVENT_HOTKEY_ID: u32 = fourcc(b"hkid");
const SIGNATURE: u32 = fourcc(b"mrin");

// Carbon modifier masks.
const CMD_KEY: u32 = 0x0100;
const SHIFT_KEY: u32 = 0x0200;
const OPTION_KEY: u32 = 0x0800;
const CONTROL_KEY: u32 = 0x1000;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: EventHandlerUPP,
        num_types: u32,
        list: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        hot_key_id: EventHotKeyID,
        target: EventTargetRef,
        options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    fn UnregisterEventHotKey(hot_key: EventHotKeyRef) -> OSStatus;
    fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        buffer_size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> OSStatus;
}

static HOTKEYS: Mutex<Option<HashMap<u32, usize>>> = Mutex::new(None);
static HANDLER_INSTALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn hotkey_handler(
    _call: EventHandlerCallRef,
    event: EventRef,
    _user: *mut c_void,
) -> OSStatus {
    let mut hk_id = EventHotKeyID {
        signature: 0,
        id: 0,
    };
    let mut actual_size: usize = 0;
    unsafe {
        GetEventParameter(
            event,
            K_EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOTKEY_ID,
            std::ptr::null_mut(),
            std::mem::size_of::<EventHotKeyID>(),
            &mut actual_size,
            &mut hk_id as *mut _ as *mut c_void,
        );
    }
    crate::engine::emit_event(&format!(
        r#"{{"type":"shortcut.trigger","id":{}}}"#,
        hk_id.id
    ));
    0 // noErr
}

fn ensure_handler() {
    if HANDLER_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spec = EventTypeSpec {
        event_class: K_EVENT_CLASS_KEYBOARD,
        event_kind: K_EVENT_HOTKEY_PRESSED,
    };
    let mut handler_ref: EventHandlerRef = std::ptr::null_mut();
    unsafe {
        InstallEventHandler(
            GetApplicationEventTarget(),
            hotkey_handler,
            1,
            &spec,
            std::ptr::null_mut(),
            &mut handler_ref,
        );
    }
}

/// Parse "Cmd+Shift+K" into (virtual key code, Carbon modifier mask).
pub fn parse(accelerator: &str) -> Option<(u32, u32)> {
    let mut modifiers = 0u32;
    let mut key_code = None;
    for part in accelerator.split('+') {
        match part.trim().to_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" => modifiers |= CMD_KEY,
            "shift" => modifiers |= SHIFT_KEY,
            "alt" | "option" => modifiers |= OPTION_KEY,
            "ctrl" | "control" => modifiers |= CONTROL_KEY,
            other => key_code = keycode_for(other),
        }
    }
    key_code.map(|code| (code, modifiers))
}

pub fn register(id: u32, accelerator: &str) -> bool {
    let Some((key_code, modifiers)) = parse(accelerator) else {
        return false;
    };
    ensure_handler();
    let hk_id = EventHotKeyID {
        signature: SIGNATURE,
        id,
    };
    let mut hotkey_ref: EventHotKeyRef = std::ptr::null_mut();
    let status = unsafe {
        RegisterEventHotKey(
            key_code,
            modifiers,
            hk_id,
            GetApplicationEventTarget(),
            0,
            &mut hotkey_ref,
        )
    };
    if status != 0 {
        return false;
    }
    HOTKEYS
        .lock()
        .expect("hotkeys")
        .get_or_insert_with(HashMap::new)
        .insert(id, hotkey_ref as usize);
    true
}

pub fn unregister(id: u32) {
    let entry = HOTKEYS
        .lock()
        .expect("hotkeys")
        .as_mut()
        .and_then(|m| m.remove(&id));
    if let Some(ptr) = entry {
        unsafe { UnregisterEventHotKey(ptr as EventHotKeyRef) };
    }
}

/// ANSI virtual key codes for the keys we accept in accelerators.
fn keycode_for(key: &str) -> Option<u32> {
    let code = match key {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" => 24,
        "9" => 25,
        "7" => 26,
        "-" => 27,
        "8" => 28,
        "0" => 29,
        "]" => 30,
        "o" => 31,
        "u" => 32,
        "[" => 33,
        "i" => 34,
        "p" => 35,
        "l" => 37,
        "j" => 38,
        "k" => 40,
        ";" => 41,
        "\\" => 42,
        "," => 43,
        "/" => 44,
        "n" => 45,
        "m" => 46,
        "." => 47,
        "`" => 50,
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    };
    Some(code)
}
