//! The NSApplication subclass CEF requires on macOS, the app delegate, and the
//! default main menu. NSApplication/CefAppProtocol plumbing adapted from
//! cef-rs's cefsimple example (Apache-2.0/MIT).

use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{
    define_class, extern_methods, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject},
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApp, NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate,
    NSApplicationTerminateReply, NSEvent,
};
use std::cell::Cell;

use crate::engine::MirinHandler;
use crate::mac::window::close_all_windows;

#[derive(Default)]
pub struct MirinApplicationIvars {
    handling_send_event: Cell<Bool>,
}

define_class!(
    /// NSApplication subclass implementing the CEF protocols so Chromium can
    /// track event dispatch and drive orderly shutdown.
    #[unsafe(super(NSApplication))]
    #[ivars = MirinApplicationIvars]
    pub struct MirinApplication;

    impl MirinApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let was_sending_event = self.is_handling_send_event();
            if !was_sending_event {
                self.set_handling_send_event(true);
            }
            let _: () = msg_send![super(self), sendEvent: event];
            if !was_sending_event {
                self.set_handling_send_event(false);
            }
        }

        /// Chromium needs `terminate:` to unwind via the message loop instead of
        /// exit(). Closing all windows drives each browser's close lifecycle,
        /// which ends the loop once the last one is gone.
        #[unsafe(method(terminate:))]
        unsafe fn terminate(&self, _sender: &AnyObject) {
            if let Some(handler) = MirinHandler::instance() {
                let already = { handler.lock().expect("lock").is_closing() };
                if !already {
                    MirinHandler::close_all_browsers(&handler, false);
                    return;
                }
            }
            close_all_windows();
        }
    }

    unsafe impl CrAppControlProtocol for MirinApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn _set_handling_send_event(&self, handling_send_event: Bool) {
            self.ivars().handling_send_event.set(handling_send_event);
        }
    }

    unsafe impl CrAppProtocol for MirinApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn _is_handling_send_event(&self) -> Bool {
            self.ivars().handling_send_event.get()
        }
    }

    unsafe impl CefAppProtocol for MirinApplication {}
);

impl MirinApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;

        #[unsafe(method(setHandlingSendEvent:))]
        fn set_handling_send_event(&self, handling_send_event: bool);

        #[unsafe(method(isHandlingSendEvent))]
        fn is_handling_send_event(&self) -> bool;
    }
}

/// Must run before anything else touches NSApp, or the shared application won't
/// be a MirinApplication and CEF's event integration breaks.
pub fn setup_application() {
    let _ = MirinApplication::shared_application();
    assert!(NSApp(MainThreadMarker::new().expect("not on main thread"))
        .isKindOfClass(MirinApplication::class()));
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    pub struct MirinAppDelegate;

    unsafe impl NSObjectProtocol for MirinAppDelegate {}

    unsafe impl NSApplicationDelegate for MirinAppDelegate {
        #[unsafe(method(applicationShouldTerminate:))]
        unsafe fn application_should_terminate(
            &self,
            _sender: &NSApplication,
        ) -> NSApplicationTerminateReply {
            NSApplicationTerminateReply::TerminateNow
        }

        #[unsafe(method(applicationSupportsSecureRestorableState:))]
        unsafe fn application_supports_secure_restorable_state(
            &self,
            _sender: &NSApplication,
        ) -> Bool {
            Bool::YES
        }
    }
);

impl MirinAppDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = MirinAppDelegate::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Install the app delegate and the default main menu (so Cmd+Q works), then
/// activate. The app can replace the menu later via `mac::menu::set_app_menu`.
pub fn setup_app_delegate() -> Retained<MirinAppDelegate> {
    let mtm = MainThreadMarker::new().expect("not on main thread");
    let app = NSApp(mtm);
    assert!(app.isKindOfClass(MirinApplication::class()));

    let delegate = MirinAppDelegate::new(mtm);
    let proto = ProtocolObject::<dyn NSApplicationDelegate>::from_retained(delegate.clone());
    app.setDelegate(Some(&proto));

    crate::mac::menu::install_default_menu(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    delegate
}
