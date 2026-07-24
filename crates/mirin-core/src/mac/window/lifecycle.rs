use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSView, NSWindow, NSWindowDelegate};
use objc2_foundation::{NSNotification, NSPoint};
use std::cell::Cell;

use super::drag::forget_window_drag;
use super::state;
use super::traffic_lights::apply_traffic_light_position;
use crate::engine::MirinHandler;

define_class!(
    /// The window's content view. Identical to `NSView` except it reports it
    /// cannot move the window: the default content view returns YES for
    /// `mouseDownCanMoveWindow`, which makes AppKit add latency to title-bar
    /// clicks while it disambiguates a click from a window drag.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    pub struct MirinContentView;

    impl MirinContentView {
        #[unsafe(method(mouseDownCanMoveWindow))]
        unsafe fn mouse_down_can_move_window(&self) -> Bool {
            Bool::NO
        }
    }
);

/// Close one window by id. Removing it from the registry drops the strong ref so
/// the NSWindow and its content view can deallocate.
pub fn close_window(id: u32) {
    forget_window_drag(id);
    if let Some(window) = state::remove_window(id) {
        window.close();
    }
}

/// Tear down a native shell whose CEF browser never reached the close handshake.
pub fn discard_window(id: u32) {
    forget_window_drag(id);
    if let Some(window) = state::remove_window(id) {
        window.setDelegate(None);
        window.close();
    }
}

/// Close every mirin-owned window (app quit path).
pub fn close_all_windows() {
    let windows: Vec<Retained<NSWindow>> = state::drain_windows();
    for window in &windows {
        window.close();
    }
}

/// Per-window delegate carrying the engine's window id so close gestures route
/// through CEF's browser-close path with the right identity.
#[derive(Default)]
pub struct MirinWindowDelegateIvars {
    window_id: Cell<u32>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MirinWindowDelegateIvars]
    pub struct MirinWindowDelegate;

    unsafe impl NSObjectProtocol for MirinWindowDelegate {}

    unsafe impl NSWindowDelegate for MirinWindowDelegate {
        /// Red-button / Cmd-W: route through CEF's close path instead of letting
        /// AppKit close the window directly.
        #[unsafe(method(windowShouldClose:))]
        unsafe fn window_should_close(&self, _sender: &NSWindow) -> Bool {
            if let Some(handler) = MirinHandler::instance() {
                let window_id = self.ivars().window_id.get();
                let already_closing =
                    { handler.lock().expect("lock").is_window_closing(window_id) };
                if !already_closing {
                    MirinHandler::close_browser_for_window(&handler, window_id);
                    return Bool::NO;
                }
            }
            Bool::YES
        }

        /// The window is actually closing: drop the registry's strong ref so it
        /// (and CEF's embedded browser view) can deallocate.
        #[unsafe(method(windowWillClose:))]
        unsafe fn window_will_close(&self, _notification: &NSNotification) {
            let id = self.ivars().window_id.get();
            forget_window_drag(id);
            state::remove_window(id);
        }

        #[unsafe(method(windowDidBecomeKey:))]
        unsafe fn window_did_become_key(&self, _n: &NSNotification) {
            let id = self.ivars().window_id.get();
            apply_traffic_light_position(id);
            crate::engine::emit_window_event(id, "focus");
        }

        #[unsafe(method(windowDidResignKey:))]
        unsafe fn window_did_resign_key(&self, _n: &NSNotification) {
            crate::engine::emit_window_event(self.ivars().window_id.get(), "blur");
        }

        #[unsafe(method(windowDidMove:))]
        unsafe fn window_did_move(&self, _n: &NSNotification) {
            emit_frame_event(self.ivars().window_id.get(), "moved");
        }

        #[unsafe(method(windowDidResize:))]
        unsafe fn window_did_resize(&self, _n: &NSNotification) {
            let id = self.ivars().window_id.get();
            apply_traffic_light_position(id);
            crate::engine::osr::resized(id);
            emit_frame_event(id, "resized");
        }

        /// Entering/exiting native fullscreen also resets the traffic-light
        /// positions, so re-apply our inset on each transition.
        #[unsafe(method(windowDidEnterFullScreen:))]
        unsafe fn window_did_enter_full_screen(&self, _n: &NSNotification) {
            apply_traffic_light_position(self.ivars().window_id.get());
        }

        #[unsafe(method(windowDidExitFullScreen:))]
        unsafe fn window_did_exit_full_screen(&self, _n: &NSNotification) {
            apply_traffic_light_position(self.ivars().window_id.get());
        }
    }
);

impl MirinWindowDelegate {
    pub(super) fn new(mtm: MainThreadMarker, window_id: u32) -> Retained<Self> {
        let this = MirinWindowDelegate::alloc(mtm).set_ivars(MirinWindowDelegateIvars {
            window_id: Cell::new(window_id),
        });
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) fn window_delegate_protocol(
    delegate: Retained<MirinWindowDelegate>,
) -> Retained<ProtocolObject<dyn NSWindowDelegate>> {
    ProtocolObject::<dyn NSWindowDelegate>::from_retained(delegate)
}

/// Current window frame (x, y bottom-left origin; width, height) in screen
/// points, or None if the window isn't open. Main thread only.
pub fn frame_of(id: u32) -> Option<(f64, f64, f64, f64)> {
    state::with_window(id, |w| {
        let f = w.frame();
        (f.origin.x, f.origin.y, f.size.width, f.size.height)
    })
}

/// Whether the window is zoomed (maximized). Main thread only.
pub fn is_zoomed(id: u32) -> bool {
    state::with_window(id, |w| w.isZoomed()).unwrap_or(false)
}

/// Move the window's bottom-left origin to screen point (x, y). Main thread only.
pub fn set_position(id: u32, x: f64, y: f64) {
    state::with_window(id, |w| w.setFrameOrigin(NSPoint::new(x, y)));
}

/// Emit a `window.<kind>` event carrying the current frame + maximized state.
pub(super) fn emit_frame_event(id: u32, kind: &str) {
    if let Some((x, y, w, h)) = frame_of(id) {
        crate::engine::emit_window_frame(id, kind, x, y, w, h, is_zoomed(id));
    }
}
