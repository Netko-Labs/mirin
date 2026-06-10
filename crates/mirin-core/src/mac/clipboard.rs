//! NSPasteboard text read/write.

use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::NSString;

pub fn read_text() -> Option<String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let value = unsafe { pasteboard.stringForType(NSPasteboardTypeString) };
    value.map(|s| s.to_string())
}

pub fn write_text(text: &str) {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let value = NSString::from_str(text);
    unsafe { pasteboard.setString_forType(&value, NSPasteboardTypeString) };
}
