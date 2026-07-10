use cef::Rect;
use objc2::{msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSView, NSWindow, NSWindowButton, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

use super::drag::mark_custom_titlebar;
use super::lifecycle::{
    emit_frame_event, window_delegate_protocol, MirinContentView, MirinWindowDelegate,
};
use super::state;
use super::types::{TitleBarStyle, WindowParams};

/// Create a mirin-owned NSWindow registered under `id`, returning its content
/// view pointer and bounds for CEF's `WindowInfo::set_as_child`.
pub fn create_window(
    mtm: MainThreadMarker,
    params: &WindowParams,
) -> (*mut std::ffi::c_void, Rect) {
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

    let needs_background_drag = params.movable_by_background
        || (params.transparent && params.title_bar_style != TitleBarStyle::Default);
    if needs_background_drag {
        window.setMovableByWindowBackground(true);
    }
    if params.title_bar_style != TitleBarStyle::Default && !params.transparent {
        window.setMovable(false);
    }
    if params.transparent {
        window.setOpaque(false);
        window.setBackgroundColor(Some(&NSColor::clearColor()));
    }
    if params.always_on_top {
        window.setLevel(3); // NSFloatingWindowLevel
    }

    let delegate = MirinWindowDelegate::new(mtm, params.id);
    let proto = window_delegate_protocol(delegate.clone());
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
    let bounds = Rect {
        x: 0,
        y: 0,
        width: params.width as i32,
        height: params.height as i32,
    };
    let content_ptr = Retained::as_ptr(&content) as *mut std::ffi::c_void;

    // Transparent windows: round the content view and clip to it, so the
    // (opaque) CEF panel gets rounded corners and the corner notches show the
    // window's clear background.
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
        mark_custom_titlebar(params.id);
    }
    state::register_window(params.id, window);
    emit_frame_event(params.id, "moved");
    (content_ptr, bounds)
}
