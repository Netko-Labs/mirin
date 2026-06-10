//! mirin-owned NSWindows: the keyed registry, per-window delegate, creation, and
//! view helpers (docs/architecture.md §1). The browser embeds as a child view;
//! closing routes through CEF's close path (see the M1 close-lifecycle finding).

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSColor, NSView, NSWindow, NSWindowButton, NSWindowDelegate,
    NSWindowStyleMask,
};
use objc2_foundation::{NSNotification, NSPoint, NSRect, NSSize, NSString};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

/// Height of the draggable strip overlaid on a custom title-bar window.
const TITLE_BAR_DRAG_HEIGHT: f64 = 38.0;

use crate::engine::MirinHandler;

thread_local! {
    /// Live mirin-owned windows, keyed by engine-assigned id. Main-thread only
    /// (NSWindow is not Send), which is where all AppKit/CEF UI work happens.
    static WINDOWS: RefCell<HashMap<u32, Retained<NSWindow>>> = RefCell::new(HashMap::new());
    /// Windows with a custom title bar that want a draggable top strip.
    static CUSTOM_TITLEBARS: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
}

/// Run `f` with the live NSWindow for `id`, if present. Main thread only.
pub fn with_window<R>(id: u32, f: impl FnOnce(&NSWindow) -> R) -> Option<R> {
    WINDOWS.with(|w| w.borrow().get(&id).map(|win| f(win)))
}

/// Close one window by id. Removing it from the registry drops the strong ref so
/// the NSWindow and its content view (holding CEF's embedded browser view) can
/// deallocate — that view destruction is what lets CEF complete its close
/// lifecycle. Main thread only.
pub fn close_window(id: u32) {
    let window = WINDOWS.with(|w| w.borrow_mut().remove(&id));
    if let Some(window) = window {
        window.close();
    }
}

/// Close every mirin-owned window (app quit path).
pub fn close_all_windows() {
    let windows: Vec<Retained<NSWindow>> =
        WINDOWS.with(|w| w.borrow_mut().drain().map(|(_, win)| win).collect());
    for window in &windows {
        window.close();
    }
}

/// Find the registry id of the window hosting the given NSView (CEF's browser
/// view), by matching the view's NSWindow against the registry.
pub fn window_id_for_view(view: *mut std::ffi::c_void) -> Option<u32> {
    let view = view as *mut AnyObject;
    let view = unsafe { view.as_ref() }?;
    let window: *mut AnyObject = unsafe { msg_send![view, window] };
    if window.is_null() {
        return None;
    }
    WINDOWS.with(|w| {
        w.borrow()
            .iter()
            .find(|(_, win)| Retained::as_ptr(win) as *mut AnyObject == window)
            .map(|(id, _)| *id)
    })
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
        /// AppKit close the window directly. Returning NO cancels the AppKit
        /// close; close_browser drives do_close -> view detach -> on_before_close.
        /// Once CEF is already closing (is_closing), allow the close to proceed.
        #[unsafe(method(windowShouldClose:))]
        unsafe fn window_should_close(&self, _sender: &NSWindow) -> Bool {
            if let Some(handler) = MirinHandler::instance() {
                let already_closing = { handler.lock().expect("lock").is_closing() };
                if !already_closing {
                    MirinHandler::close_all_browsers(&handler, false);
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
            WINDOWS.with(|w| {
                w.borrow_mut().remove(&id);
            });
        }

        #[unsafe(method(windowDidBecomeKey:))]
        unsafe fn window_did_become_key(&self, _n: &NSNotification) {
            crate::engine::emit_window_event(self.ivars().window_id.get(), "focus");
        }

        #[unsafe(method(windowDidResignKey:))]
        unsafe fn window_did_resign_key(&self, _n: &NSNotification) {
            crate::engine::emit_window_event(self.ivars().window_id.get(), "blur");
        }

        #[unsafe(method(windowDidMove:))]
        unsafe fn window_did_move(&self, _n: &NSNotification) {
            crate::engine::emit_window_event(self.ivars().window_id.get(), "moved");
        }

        #[unsafe(method(windowDidResize:))]
        unsafe fn window_did_resize(&self, _n: &NSNotification) {
            crate::engine::emit_window_event(self.ivars().window_id.get(), "resized");
        }
    }
);

impl MirinWindowDelegate {
    fn new(mtm: MainThreadMarker, window_id: u32) -> Retained<Self> {
        let this = MirinWindowDelegate::alloc(mtm).set_ivars(MirinWindowDelegateIvars {
            window_id: Cell::new(window_id),
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// How the window's title bar is presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBarStyle {
    /// Standard titled window.
    Default,
    /// Title bar hidden, content fills; traffic-light buttons remain.
    Hidden,
    /// Title bar transparent and content extends under it; inset traffic lights.
    HiddenInset,
}

/// Window creation parameters resolved by the engine.
pub struct WindowParams<'a> {
    pub id: u32,
    pub title: &'a str,
    pub width: f64,
    pub height: f64,
    pub title_bar_style: TitleBarStyle,
    pub transparent: bool,
    pub always_on_top: bool,
    pub movable_by_background: bool,
    pub show: bool,
}

/// Create a mirin-owned NSWindow registered under `id`, returning its content
/// view pointer and bounds for CEF's `WindowInfo::set_as_child`.
pub fn create_window(
    mtm: MainThreadMarker,
    params: &WindowParams,
) -> (*mut std::ffi::c_void, cef::Rect) {
    let content_rect = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(params.width, params.height),
    );
    let mut style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
    if params.title_bar_style != TitleBarStyle::Default {
        style |= NSWindowStyleMask::FullSizeContentView;
    }

    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            content_rect,
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(params.title));
    window.center();

    match params.title_bar_style {
        TitleBarStyle::Default => {}
        TitleBarStyle::HiddenInset => {
            window.setTitlebarAppearsTransparent(true);
            window.setTitleVisibility(objc2_app_kit::NSWindowTitleVisibility::Hidden);
        }
        TitleBarStyle::Hidden => {
            // Borderless look: transparent bar, hidden title, and no traffic lights.
            window.setTitlebarAppearsTransparent(true);
            window.setTitleVisibility(objc2_app_kit::NSWindowTitleVisibility::Hidden);
            for button in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                if let Some(b) = window.standardWindowButton(button) {
                    b.setHidden(true);
                }
            }
        }
    }
    if params.movable_by_background || params.title_bar_style != TitleBarStyle::Default {
        window.setMovableByWindowBackground(true);
    }
    if params.transparent {
        window.setOpaque(false);
        window.setBackgroundColor(Some(&NSColor::clearColor()));
    }
    if params.always_on_top {
        window.setLevel(3); // NSFloatingWindowLevel
    }

    let delegate = MirinWindowDelegate::new(mtm, params.id);
    let proto = ProtocolObject::<dyn NSWindowDelegate>::from_retained(delegate.clone());
    window.setDelegate(Some(&proto));
    std::mem::forget(delegate); // setDelegate is weak; keep it alive for the window's life

    if params.show {
        window.makeKeyAndOrderFront(None);
    }

    let content = window.contentView().expect("window has no content view");
    let bounds = cef::Rect {
        x: 0,
        y: 0,
        width: params.width as i32,
        height: params.height as i32,
    };
    let content_ptr = Retained::as_ptr(&content) as *mut std::ffi::c_void;

    if params.title_bar_style != TitleBarStyle::Default {
        CUSTOM_TITLEBARS.with(|s| s.borrow_mut().insert(params.id));
    }
    WINDOWS.with(|w| w.borrow_mut().insert(params.id, window));
    (content_ptr, bounds)
}

define_class!(
    /// A transparent view that reports it can move the window when dragged. CEF
    /// doesn't honor `-webkit-app-region`, so we overlay this on the title-bar
    /// strip of custom-title-bar windows to make them draggable.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    struct TitleBarDragView;

    impl TitleBarDragView {
        #[unsafe(method(mouseDownCanMoveWindow))]
        unsafe fn mouse_down_can_move_window(&self) -> Bool {
            Bool::YES
        }
    }
);

/// If `id` is a custom-title-bar window, overlay a draggable strip across its
/// top. Call after the CEF browser view exists so the strip sits on top of it.
pub fn add_titlebar_drag(id: u32) {
    if !CUSTOM_TITLEBARS.with(|s| s.borrow().contains(&id)) {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    with_window(id, |window| {
        let Some(content) = window.contentView() else {
            return;
        };
        let bounds = content.bounds();
        let frame = NSRect::new(
            NSPoint::new(0.0, bounds.size.height - TITLE_BAR_DRAG_HEIGHT),
            NSSize::new(bounds.size.width, TITLE_BAR_DRAG_HEIGHT),
        );
        let drag: Retained<TitleBarDragView> =
            unsafe { msg_send![TitleBarDragView::alloc(mtm), initWithFrame: frame] };
        // Width-sizable + flexible bottom margin keeps the strip pinned to the top.
        const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
        const NS_VIEW_MIN_Y_MARGIN: u64 = 8;
        unsafe {
            let _: () =
                msg_send![&drag, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_MIN_Y_MARGIN];
            let _: () = msg_send![&content, addSubview: &*drag];
        }
        std::mem::forget(drag);
    });
}

pub fn set_window_title(id: u32, title: &str) {
    with_window(id, |w| w.setTitle(&NSString::from_str(title)));
}

/// Apply a control verb to a window. Main thread only.
pub fn control(id: u32, verb: &str) {
    const NORMAL_LEVEL: isize = 0;
    const FLOATING_LEVEL: isize = 3; // NSFloatingWindowLevel
    with_window(id, |w| {
        match verb {
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
        }
    });
}

/// Detach CEF's browser NSView from its superview, tearing down the view
/// hierarchy so `do_close` returning false makes CEF fire `on_before_close`.
///
/// Safety: `view` must be a live NSView pointer (CEF's window handle on macOS).
pub unsafe fn detach_browser_view(view: *mut std::ffi::c_void) {
    let view = view as *mut AnyObject;
    if let Some(view) = view.as_ref() {
        let _: () = msg_send![view, removeFromSuperview];
    }
}

/// Make the CEF-created browser NSView track its parent's size.
///
/// Safety: `view` must be a live NSView pointer (CEF's window handle on macOS).
pub unsafe fn make_view_autoresizing(view: *mut std::ffi::c_void) {
    const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
    const NS_VIEW_HEIGHT_SIZABLE: u64 = 16;
    let view = view as *mut AnyObject;
    if let Some(view) = view.as_ref() {
        let _: () =
            msg_send![view, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
    }
}
