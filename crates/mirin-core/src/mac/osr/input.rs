use objc2_app_kit::NSEvent;

/// Per-keystroke event type codes shared with engine::osr (CefKeyEventType).
pub(super) const KEY_RAWKEYDOWN: i32 = 0;
pub(super) const KEY_KEYUP: i32 = 2;
pub(super) const KEY_CHAR: i32 = 3;

/// Mouse button codes shared with engine::osr (0=left, 1=right, 2=middle).
pub(super) const BUTTON_LEFT: i32 = 0;
pub(super) const BUTTON_RIGHT: i32 = 1;

pub(super) fn modifiers(event: &NSEvent) -> u32 {
    let flags = event.modifierFlags().0;
    let mut m = 0u32;
    const SHIFT: usize = 1 << 17;
    const CONTROL: usize = 1 << 18;
    const OPTION: usize = 1 << 19;
    const COMMAND: usize = 1 << 20;
    if flags & SHIFT != 0 {
        m |= 2; // EVENTFLAG_SHIFT_DOWN
    }
    if flags & CONTROL != 0 {
        m |= 4; // EVENTFLAG_CONTROL_DOWN
    }
    if flags & OPTION != 0 {
        m |= 8; // EVENTFLAG_ALT_DOWN
    }
    if flags & COMMAND != 0 {
        m |= 128; // EVENTFLAG_COMMAND_DOWN
    }
    m
}

pub(super) fn first_char(event: &NSEvent) -> Option<u16> {
    let chars = event.characters()?;
    chars.to_string().encode_utf16().next()
}

/// The character the key would produce ignoring modifiers (used for CEF's
/// `unmodified_character`, which it needs to identify shortcut keys).
pub(super) fn first_unmodified_char(event: &NSEvent) -> Option<u16> {
    let chars = event.charactersIgnoringModifiers()?;
    chars.to_string().encode_utf16().next()
}

/// AppKit reports arrows, F-keys, page nav, etc. as characters in the Unicode
/// private-use range 0xF700-0xF8FF, not real text.
pub(super) fn is_function_key(ch: u16) -> bool {
    (0xF700..=0xF8FF).contains(&ch)
}

/// (windows_key_code, native_key_code) for a key event.
pub(super) fn key_codes(event: &NSEvent) -> (i32, i32) {
    let native = event.keyCode() as i32;
    let vk = match native {
        36 => 0x0D,  // Return
        48 => 0x09,  // Tab
        49 => 0x20,  // Space
        51 => 0x08,  // Backspace
        53 => 0x1B,  // Escape
        123 => 0x25, // Left
        124 => 0x27, // Right
        125 => 0x28, // Down
        126 => 0x26, // Up
        _ => first_char(event)
            .map(|c| (c as u8).to_ascii_uppercase() as i32)
            .unwrap_or(0),
    };
    (vk, native)
}
