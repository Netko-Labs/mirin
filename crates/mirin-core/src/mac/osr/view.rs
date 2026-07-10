use objc2::{
    define_class, msg_send,
    runtime::{Bool, NSObjectProtocol},
    DefinedClass, MainThreadOnly,
};
use objc2_app_kit::{NSEvent, NSView};
use objc2_foundation::NSPoint;
use std::cell::Cell;

use super::input::{
    first_char, first_unmodified_char, is_function_key, key_codes, modifiers, BUTTON_LEFT,
    BUTTON_RIGHT, KEY_CHAR, KEY_KEYUP, KEY_RAWKEYDOWN,
};

#[derive(Default)]
pub struct MirinOsrViewIvars {
    window_id: Cell<u32>,
}

define_class!(
    /// Transparent, flipped, first-responder view that displays CEF's painted
    /// buffer and forwards input. Flipped so its coordinate origin (top-left)
    /// matches CEF's.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = MirinOsrViewIvars]
    pub struct MirinOsrView;

    unsafe impl NSObjectProtocol for MirinOsrView {}

    impl MirinOsrView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> Bool {
            Bool::YES
        }

        #[unsafe(method(mouseDown:))]
        unsafe fn mouse_down(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_LEFT, false);
        }
        #[unsafe(method(mouseUp:))]
        unsafe fn mouse_up(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_LEFT, true);
        }
        #[unsafe(method(rightMouseDown:))]
        unsafe fn right_mouse_down(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_RIGHT, false);
        }
        #[unsafe(method(rightMouseUp:))]
        unsafe fn right_mouse_up(&self, event: &NSEvent) {
            self.mouse(event, BUTTON_RIGHT, true);
        }
        #[unsafe(method(mouseDragged:))]
        unsafe fn mouse_dragged(&self, event: &NSEvent) {
            self.mouse_move(event);
        }
        #[unsafe(method(mouseMoved:))]
        unsafe fn mouse_moved(&self, event: &NSEvent) {
            self.mouse_move(event);
        }
        #[unsafe(method(scrollWheel:))]
        unsafe fn scroll_wheel(&self, event: &NSEvent) {
            let (x, y) = self.point(event);
            let dx = event.scrollingDeltaX() as i32;
            let dy = event.scrollingDeltaY() as i32;
            crate::engine::osr::mouse_wheel(self.window_id(), x, y, dx, dy, modifiers(event));
        }
        #[unsafe(method(keyDown:))]
        unsafe fn key_down(&self, event: &NSEvent) {
            self.key(event, KEY_RAWKEYDOWN);
            // Then a CHAR event so text actually gets inserted, but only for
            // real text, not arrows/F-keys/nav keys.
            if let Some(ch) = first_char(event) {
                if !is_function_key(ch) {
                    let id = self.window_id();
                    let (vk, native) = key_codes(event);
                    crate::engine::osr::key(id, KEY_CHAR, modifiers(event), vk, native, ch, ch);
                }
            }
        }
        #[unsafe(method(keyUp:))]
        unsafe fn key_up(&self, event: &NSEvent) {
            self.key(event, KEY_KEYUP);
        }
    }
);

impl MirinOsrView {
    pub(super) fn window_id(&self) -> u32 {
        self.ivars().window_id.get()
    }

    /// Convert an event's location to flipped view coordinates (top-left, points).
    fn point(&self, event: &NSEvent) -> (i32, i32) {
        let loc = event.locationInWindow();
        let p: NSPoint =
            unsafe { msg_send![self, convertPoint: loc, fromView: std::ptr::null::<NSView>()] };
        (p.x as i32, p.y as i32)
    }

    /// Forward a mouse button press/release. `up` distinguishes release from press.
    fn mouse(&self, event: &NSEvent, button: i32, up: bool) {
        let (x, y) = self.point(event);
        let count = event.clickCount() as i32;
        crate::engine::osr::mouse_click(
            self.window_id(),
            x,
            y,
            modifiers(event),
            button,
            up,
            count,
        );
    }

    fn mouse_move(&self, event: &NSEvent) {
        let (x, y) = self.point(event);
        crate::engine::osr::mouse_move(self.window_id(), x, y, modifiers(event), false);
    }

    fn key(&self, event: &NSEvent, type_code: i32) {
        let (vk, native) = key_codes(event);
        // Populate character/unmodified_character even for non-text keys. Left
        // zero, Chromium's macOS OSR path re-interprets the event and dispatches
        // a duplicate keydown for special keys.
        let ch = first_char(event).unwrap_or(0);
        let unmod = first_unmodified_char(event).unwrap_or(ch);
        crate::engine::osr::key(
            self.window_id(),
            type_code,
            modifiers(event),
            vk,
            native,
            ch,
            unmod,
        );
    }
}

pub(super) fn new_view(
    mtm: objc2::MainThreadMarker,
    window_id: u32,
    frame: objc2_foundation::NSRect,
) -> objc2::rc::Retained<MirinOsrView> {
    let this = MirinOsrView::alloc(mtm).set_ivars(MirinOsrViewIvars {
        window_id: Cell::new(window_id),
    });
    unsafe { msg_send![super(this), initWithFrame: frame] }
}
