use objc2::{msg_send, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSView};
use objc2_foundation::{NSRect, NSString};

use super::state::with_window;

pub fn set_window_title(id: u32, title: &str) {
    with_window(id, |w| w.setTitle(&NSString::from_str(title)));
}

/// Backing scale factor (points->pixels) of the window's screen, for OSR.
pub fn backing_scale(id: u32) -> Option<f32> {
    with_window(id, |w| {
        w.screen()
            .map(|s| s.backingScaleFactor() as f32)
            .unwrap_or(2.0)
    })
}

/// Replace the window's content view (used by OSR to install its render view,
/// optionally wrapped in a native material container) and make `responder` the
/// first responder so the OSR view receives keyboard input.
pub fn set_content_view(id: u32, content: &NSView, responder: &NSView) {
    with_window(id, |w| {
        w.setContentView(Some(content));
        w.makeFirstResponder(Some(responder));
    });
}

/// Apply a control verb to a window. Main thread only.
pub fn control(id: u32, verb: &str) {
    const NORMAL_LEVEL: isize = 0;
    const FLOATING_LEVEL: isize = 3; // NSFloatingWindowLevel
    with_window(id, |w| match verb {
        "minimize" => w.miniaturize(None),
        "restore" => w.deminiaturize(None),
        "maximize" => w.zoom(None),
        "fullscreen" => w.toggleFullScreen(None),
        "focus" | "show" => {
            w.makeKeyAndOrderFront(None);
            // Bring the app forward too, so a hotkey-summoned panel appears
            // even when the app is in the background.
            if let Some(mtm) = MainThreadMarker::new() {
                #[allow(deprecated)]
                NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            }
        }
        "hide" => w.orderOut(None),
        "center" => w.center(),
        "alwaysOnTop:on" => w.setLevel(FLOATING_LEVEL),
        "alwaysOnTop:off" => w.setLevel(NORMAL_LEVEL),
        _ => {}
    });
}

/// Detach CEF's browser NSView from its superview, tearing down the view
/// hierarchy so `do_close` returning false makes CEF fire `on_before_close`.
///
/// # Safety
/// `view` must be a live NSView pointer (CEF's window handle on macOS).
pub unsafe fn detach_browser_view(view: *mut std::ffi::c_void) {
    let view = view as *mut AnyObject;
    if let Some(view) = view.as_ref() {
        let _: () = msg_send![view, removeFromSuperview];
    }
}

/// Make the CEF-created browser NSView track its parent's size.
///
/// # Safety
/// `view` must be a live NSView pointer (CEF's window handle on macOS).
pub unsafe fn make_view_autoresizing(view: *mut std::ffi::c_void) {
    const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
    const NS_VIEW_HEIGHT_SIZABLE: u64 = 16;
    let view = view as *mut AnyObject;
    if let Some(view) = view.as_ref() {
        // Snap the view to its parent's current bounds before enabling autoresize.
        let superview: *mut AnyObject = msg_send![view, superview];
        if let Some(superview) = superview.as_ref() {
            let bounds: NSRect = msg_send![superview, bounds];
            let _: () = msg_send![view, setFrame: bounds];
        }
        let _: () =
            msg_send![view, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
    }
}
