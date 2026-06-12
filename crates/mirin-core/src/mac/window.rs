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
    NSApplication, NSBackingStoreType, NSColor, NSEvent, NSView, NSWindow, NSWindowButton,
    NSWindowDelegate, NSWindowStyleMask,
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
    /// The draggable overlay view per custom-title-bar window, kept so we can
    /// resize it once the page reports `-webkit-app-region` regions.
    static DRAG_VIEWS: RefCell<HashMap<u32, Retained<TitleBarDragView>>> =
        RefCell::new(HashMap::new());
    /// `-webkit-app-region` regions reported by CEF, per window (web/top-left
    /// coords). Absent until a page declares them; then the overlay hit-tests
    /// against these instead of acting as a blanket strip.
    static DRAG_REGIONS: RefCell<HashMap<u32, Vec<DragRegion>>> = RefCell::new(HashMap::new());
}

/// One `-webkit-app-region` rectangle in web coordinates (top-left origin).
#[derive(Clone, Copy)]
pub struct DragRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub draggable: bool,
}

define_class!(
    /// The window's content view. Identical to `NSView` except it reports it
    /// cannot move the window: the default content view returns YES for
    /// `mouseDownCanMoveWindow`, which makes AppKit add latency to title-bar
    /// clicks while it disambiguates a click from a window drag (web controls in
    /// a custom title bar feel laggy as a result). Dragging still works — the
    /// overlay drives it explicitly via `performWindowDragWithEvent:`. CEF's own
    /// browser views already report NO, so only this view needed fixing.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    struct MirinContentView;

    impl MirinContentView {
        #[unsafe(method(mouseDownCanMoveWindow))]
        unsafe fn mouse_down_can_move_window(&self) -> Bool {
            Bool::NO
        }
    }
);

/// Run `f` with the live NSWindow for `id`, if present. Main thread only.
pub fn with_window<R>(id: u32, f: impl FnOnce(&NSWindow) -> R) -> Option<R> {
    WINDOWS.with(|w| w.borrow().get(&id).map(|win| f(win)))
}

/// Close one window by id. Removing it from the registry drops the strong ref so
/// the NSWindow and its content view (holding CEF's embedded browser view) can
/// deallocate — that view destruction is what lets CEF complete its close
/// lifecycle. Main thread only.
pub fn close_window(id: u32) {
    forget_window_drag(id);
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
            forget_window_drag(id);
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
            emit_frame_event(self.ivars().window_id.get(), "moved");
        }

        #[unsafe(method(windowDidResize:))]
        unsafe fn window_did_resize(&self, _n: &NSNotification) {
            let id = self.ivars().window_id.get();
            // Windowless (OSR) windows must tell CEF to re-query the view size.
            crate::engine::osr::resized(id);
            emit_frame_event(id, "resized");
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
    /// Screen position (bottom-left origin, points). Centered when absent.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub title_bar_style: TitleBarStyle,
    pub transparent: bool,
    pub always_on_top: bool,
    pub movable_by_background: bool,
    pub show: bool,
}

/// Current window frame (x, y bottom-left origin; width, height) in screen
/// points, or None if the window isn't open. Main thread only.
pub fn frame_of(id: u32) -> Option<(f64, f64, f64, f64)> {
    with_window(id, |w| {
        let f = w.frame();
        (f.origin.x, f.origin.y, f.size.width, f.size.height)
    })
}

/// Whether the window is zoomed (maximized). Main thread only.
pub fn is_zoomed(id: u32) -> bool {
    with_window(id, |w| w.isZoomed()).unwrap_or(false)
}

/// Move the window's bottom-left origin to screen point (x, y). Main thread only.
pub fn set_position(id: u32, x: f64, y: f64) {
    with_window(id, |w| w.setFrameOrigin(NSPoint::new(x, y)));
}

/// Emit a `window.<kind>` event carrying the current frame + maximized state.
fn emit_frame_event(id: u32, kind: &str) {
    if let Some((x, y, w, h)) = frame_of(id) {
        crate::engine::emit_window_frame(id, kind, x, y, w, h, is_zoomed(id));
    }
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
    // Restore a saved position if given, else center.
    match (params.x, params.y) {
        (Some(x), Some(y)) => window.setFrameOrigin(NSPoint::new(x, y)),
        _ => window.center(),
    }

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
    // Opaque (windowed) custom-title-bar windows drag via the overlay's
    // `mouseDown:` (performWindowDragWithEvent:), which is immediate. We avoid
    // `movableByWindowBackground` there: it makes AppKit run window-drag
    // detection on every title-bar click, which noticeably delays clicks on web
    // controls in the bar. Transparent (OSR) windows have no overlay, so they
    // still rely on it for dragging.
    let needs_background_drag = params.movable_by_background
        || (params.transparent && params.title_bar_style != TitleBarStyle::Default);
    if needs_background_drag {
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

    // Install our own content view (won't move the window on click) so title-bar
    // control clicks aren't delayed; CEF embeds its browser into it.
    let content: Retained<NSView> = {
        let frame = window.contentView().map(|v| v.frame()).unwrap_or_else(|| {
            NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(params.width, params.height),
            )
        });
        let view = MirinContentView::alloc(mtm).set_ivars(());
        let view: Retained<MirinContentView> =
            unsafe { msg_send![super(view), initWithFrame: frame] };
        window.setContentView(Some(&view));
        Retained::into_super(view)
    };
    let bounds = cef::Rect {
        x: 0,
        y: 0,
        width: params.width as i32,
        height: params.height as i32,
    };
    let content_ptr = Retained::as_ptr(&content) as *mut std::ffi::c_void;

    // Transparent windows: round the content view and clip to it, so the
    // (opaque) CEF panel gets rounded corners and the corner notches show the
    // window's clear background (the desktop) — a clean borderless floating
    // panel. (A windowed CEF browser can't be see-through; that needs OSR.)
    if params.transparent {
        unsafe {
            let _: () = msg_send![&*content, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![&*content, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: 14.0_f64];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        }
    }

    if params.title_bar_style != TitleBarStyle::Default {
        CUSTOM_TITLEBARS.with(|s| s.borrow_mut().insert(params.id));
    }
    WINDOWS.with(|w| w.borrow_mut().insert(params.id, window));
    // Seed the worker's tracked frame with the initial geometry.
    emit_frame_event(params.id, "moved");
    (content_ptr, bounds)
}

/// Ivars for the title-bar drag overlay: which window it belongs to, so its
/// `hitTest:` can look up that window's reported draggable regions.
#[derive(Default)]
struct TitleBarDragViewIvars {
    window_id: Cell<u32>,
}

/// Outcome of testing a point against a window's draggable regions.
enum RegionHit {
    /// No regions reported yet — fall back to the blanket top strip.
    NoRegions,
    /// Inside a draggable region (and no hole): the overlay handles the drag.
    Drag,
    /// Outside any draggable region: let the click reach the webview.
    PassThrough,
}

define_class!(
    /// A transparent overlay that moves the window when dragged. CEF doesn't apply
    /// `-webkit-app-region` to the native window itself, so we sit this on top of
    /// the browser view. Once the page reports app-regions (via the DragHandler),
    /// `hitTest:` returns self only inside a draggable region and `nil` elsewhere
    /// — so window controls underneath stay clickable. Before any region is
    /// reported it falls back to a blanket top strip.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TitleBarDragViewIvars]
    struct TitleBarDragView;

    impl TitleBarDragView {
        /// Start a window drag immediately on mouse-down in a drag region.
        /// `performWindowDragWithEvent:` distinguishes click vs. drag without the
        /// latency `mouseDownCanMoveWindow` + movableByWindowBackground impose on
        /// title-bar clicks, so web controls beside the drag area feel instant.
        #[unsafe(method(mouseDown:))]
        unsafe fn mouse_down(&self, event: &NSEvent) {
            if let Some(window) = self.window() {
                let _: () = unsafe { msg_send![&window, performWindowDragWithEvent: event] };
            }
        }

        #[unsafe(method(hitTest:))]
        unsafe fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let id = self.ivars().window_id.get();
            // `point` is in our superview (content view) coords: bottom-left
            // origin. CEF regions are top-left, so flip with the content height.
            let height = self
                .superview()
                .map(|sv| sv.bounds().size.height)
                .unwrap_or(0.0);
            // Resolve hit/miss inside the borrow to avoid cloning the region list
            // on every hit-test (these fire continuously during mouse movement).
            let decision = DRAG_REGIONS.with(|r| {
                let map = r.borrow();
                let Some(regions) = map.get(&id) else {
                    return RegionHit::NoRegions;
                };
                let mut in_drag = false;
                let mut in_hole = false;
                for region in regions {
                    let y = height - (region.y + region.h);
                    let inside = point.x >= region.x
                        && point.x <= region.x + region.w
                        && point.y >= y
                        && point.y <= y + region.h;
                    if inside {
                        if region.draggable {
                            in_drag = true;
                        } else {
                            in_hole = true;
                        }
                    }
                }
                if in_drag && !in_hole {
                    RegionHit::Drag
                } else {
                    RegionHit::PassThrough
                }
            });
            match decision {
                // No app-region info yet: behave as a plain (blanket) drag view.
                RegionHit::NoRegions => unsafe { msg_send![super(self), hitTest: point] },
                RegionHit::Drag => {
                    let this: *const TitleBarDragView = self;
                    this as *mut NSView
                }
                // Not a drag area (e.g. a button): let the click reach the webview.
                RegionHit::PassThrough => std::ptr::null_mut(),
            }
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
        let this = TitleBarDragView::alloc(mtm).set_ivars(TitleBarDragViewIvars {
            window_id: Cell::new(id),
        });
        let drag: Retained<TitleBarDragView> =
            unsafe { msg_send![super(this), initWithFrame: frame] };
        // Width-sizable + flexible bottom margin keeps the strip pinned to the top.
        const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
        const NS_VIEW_MIN_Y_MARGIN: u64 = 8;
        unsafe {
            let _: () =
                msg_send![&drag, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_MIN_Y_MARGIN];
            let _: () = msg_send![&content, addSubview: &*drag];
        }
        DRAG_VIEWS.with(|v| {
            v.borrow_mut().insert(id, drag);
        });
    });
}

/// Apply the `-webkit-app-region` regions a page reported (via CEF's DragHandler)
/// to a window's drag overlay. Grows the overlay to cover the whole content view
/// so its `hitTest:` governs the entire surface; no-op for windows without an
/// overlay (e.g. windowless/OSR). Main thread only.
pub fn set_draggable_regions(id: u32, regions: Vec<DragRegion>) {
    let view = DRAG_VIEWS.with(|v| v.borrow().get(&id).cloned());
    let Some(view) = view else {
        return;
    };
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().insert(id, regions);
    });
    if let Some(content) = unsafe { view.superview() } {
        let bounds = content.bounds();
        const NS_VIEW_WIDTH_SIZABLE: u64 = 2;
        const NS_VIEW_HEIGHT_SIZABLE: u64 = 16;
        unsafe {
            let _: () = msg_send![&*view, setFrame: bounds];
            let _: () = msg_send![&*view, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
        }
    }
}

/// Drop a window's drag overlay + regions (close path). Main thread only.
fn forget_window_drag(id: u32) {
    DRAG_VIEWS.with(|v| {
        v.borrow_mut().remove(&id);
    });
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().remove(&id);
    });
}

pub fn set_window_title(id: u32, title: &str) {
    with_window(id, |w| w.setTitle(&NSString::from_str(title)));
}

/// Backing scale factor (points→pixels) of the window's screen, for OSR.
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
        let _: () =
            msg_send![view, setAutoresizingMask: NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE];
    }
}
