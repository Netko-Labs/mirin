use objc2::{define_class, msg_send, rc::Retained, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSEvent, NSView, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use super::state::with_window;
use super::types::DragRegion;

/// Height of the draggable strip overlaid on a custom title-bar window.
const TITLE_BAR_DRAG_HEIGHT: f64 = 38.0;

thread_local! {
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

pub(super) fn mark_custom_titlebar(id: u32) {
    CUSTOM_TITLEBARS.with(|s| {
        s.borrow_mut().insert(id);
    });
}

/// Run the user's configured "double-click the title bar" action, since we set
/// the window non-movable (which also disables AppKit's built-in handling).
fn perform_titlebar_double_click(window: &NSWindow) {
    let action = objc2_foundation::NSUserDefaults::standardUserDefaults()
        .stringForKey(&NSString::from_str("AppleActionOnDoubleClick"));
    match action.as_ref().map(|s| s.to_string()).as_deref() {
        Some("Minimize") => window.miniaturize(None),
        Some("None") => {}
        _ => window.zoom(None),
    }
}

/// Ivars for the title-bar drag overlay: which window it belongs to, so its
/// `hitTest:` can look up that window's reported draggable regions.
#[derive(Default)]
struct TitleBarDragViewIvars {
    window_id: Cell<u32>,
}

/// Outcome of testing a point against a window's draggable regions.
enum RegionHit {
    /// No regions reported yet: fall back to the blanket top strip.
    NoRegions,
    /// Inside a draggable region (and no hole): the overlay handles the drag.
    Drag,
    /// Outside any draggable region: let the click reach the webview.
    PassThrough,
}

define_class!(
    /// A transparent overlay that moves the window when dragged. CEF doesn't apply
    /// `-webkit-app-region` to the native window itself, so we sit this on top of
    /// the browser view.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TitleBarDragViewIvars]
    struct TitleBarDragView;

    impl TitleBarDragView {
        /// Drive window dragging (and the standard title-bar double-click action)
        /// for the drag region.
        #[unsafe(method(mouseDown:))]
        unsafe fn mouse_down(&self, event: &NSEvent) {
            let Some(window) = self.window() else {
                return;
            };
            let click_count: isize = unsafe { msg_send![event, clickCount] };
            if click_count == 2 {
                perform_titlebar_double_click(&window);
            } else {
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
                RegionHit::NoRegions => unsafe { msg_send![super(self), hitTest: point] },
                RegionHit::Drag => {
                    let this: *const TitleBarDragView = self;
                    this as *mut NSView
                }
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
/// to a window's drag overlay.
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
pub(super) fn forget_window_drag(id: u32) {
    CUSTOM_TITLEBARS.with(|s| {
        s.borrow_mut().remove(&id);
    });
    DRAG_VIEWS.with(|v| {
        v.borrow_mut().remove(&id);
    });
    DRAG_REGIONS.with(|r| {
        r.borrow_mut().remove(&id);
    });
}
