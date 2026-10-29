use cef::*;
use std::cell::RefCell;

use super::icons::install_window_props;

// Minimal browser-view delegate. Popups (window.open / target=_blank) get their
// own top-level Views window, mirroring cefsimple.
wrap_browser_view_delegate! {
    pub struct MirinBrowserViewDelegate {}

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: i32,
        ) -> i32 {
            let mut delegate = MirinWindowDelegate::new(
                RefCell::new(popup_browser_view.cloned()),
                0, // popups are not mirin windows: no id, no frame/focus events
                String::new(),
                WindowGeometry::default(),
                RefCell::new(None),
                true,
                false,
                false, // popups get standard decorations
            );
            window_create_top_level(Some(&mut delegate));
            1
        }

        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

/// Requested geometry for a new top-level window. `x`/`y` are screen pixels;
/// `None` centers the window on its display.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowGeometry {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: i32,
    pub height: i32,
    pub min_width: i32,
    pub min_height: i32,
}

// Top-level window delegate: attaches the browser view, sizes/shows the window,
// reports frame/focus changes to the Worker, and routes close through the
// browser.
wrap_window_delegate! {
    pub struct MirinWindowDelegate {
        browser_view: RefCell<Option<BrowserView>>,
        window_id: u32,
        title: String,
        geometry: WindowGeometry,
        // Last reported (width, height), to tell a move from a resize.
        last_size: RefCell<Option<(i32, i32)>>,
        show: bool,
        always_on_top: bool,
        frameless: bool,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: self.geometry.width.max(1), height: self.geometry.height.max(1) }
        }

        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: self.geometry.min_width.max(0), height: self.geometry.min_height.max(0) }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn is_frameless(&self, _window: Option<&mut Window>) -> i32 {
            self.frameless as i32
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        // A saved frame (`x`/`y` given) places the window there; otherwise an
        // empty rect lets CEF pick and `on_window_created` centers it.
        fn initial_bounds(&self, _window: Option<&mut Window>) -> Rect {
            match (self.geometry.x, self.geometry.y) {
                (Some(x), Some(y)) if self.geometry.width > 0 && self.geometry.height > 0 => Rect {
                    x,
                    y,
                    width: self.geometry.width,
                    height: self.geometry.height,
                },
                _ => Rect::default(),
            }
        }

        fn on_window_bounds_changed(&self, window: Option<&mut Window>, new_bounds: Option<&Rect>) {
            let (Some(window), Some(bounds)) = (window, new_bounds) else { return };
            if self.window_id == 0 {
                return;
            }
            let size = (bounds.width, bounds.height);
            let kind = match self.last_size.replace(Some(size)) {
                Some(previous) if previous == size => "moved",
                _ => "resized",
            };
            crate::engine::emit_window_frame(
                self.window_id,
                kind,
                bounds.x as f64,
                bounds.y as f64,
                bounds.width as f64,
                bounds.height as f64,
                window.is_maximized() != 0,
            );
        }

        fn on_window_activation_changed(&self, _window: Option<&mut Window>, active: i32) {
            if self.window_id == 0 {
                return;
            }
            crate::engine::emit_window_event(self.window_id, if active != 0 { "focus" } else { "blur" });
        }

        fn on_window_created(&self, window: Option<&mut Window>) {
            let browser_view = self.browser_view.borrow();
            let (Some(window), Some(browser_view)) = (window, browser_view.as_ref()) else {
                return;
            };
            let _ = window.set_to_fill_layout();
            let mut view = View::from(browser_view);
            window.add_child_view(Some(&mut view));

            if !self.title.is_empty() {
                window.set_title(Some(&CefString::from(self.title.as_str())));
            }
            let placed = self.geometry.x.is_some() && self.geometry.y.is_some();
            if !placed && self.geometry.width > 0 && self.geometry.height > 0 {
                window.center_window(Some(&Size {
                    width: self.geometry.width,
                    height: self.geometry.height,
                }));
            }
            if self.always_on_top {
                window.set_always_on_top(1);
            }
            if self.show {
                window.show();
                window.activate();
            }
            install_window_props(window.window_handle());
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            *self.browser_view.borrow_mut() = None;
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let browser_view = self.browser_view.borrow();
            let Some(browser_view) = browser_view.as_ref() else { return 1 };
            if let Some(browser) = browser_view.browser() {
                if let Some(host) = browser.host() {
                    return host.try_close_browser();
                }
            }
            1
        }

        fn window_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

/// Stamp mirin's `window_id` onto the browser view's `View::id`, so the shared
/// LifeSpanHandler can map a Browser -> window in `on_after_created`.
pub fn tag_browser_view(browser_view: &BrowserView, window_id: u32) {
    let view = View::from(browser_view);
    view.set_id(window_id as i32);
}

/// Map a live Browser back to the mirin `window_id` we stamped on its browser
/// view (`tag_browser_view`). `None` if it is not one of ours.
pub fn window_id_for_browser(browser: &mut Browser) -> Option<u32> {
    let browser_view = browser_view_get_for_browser(Some(browser))?;
    let id = View::from(&browser_view).id();
    (id > 0).then_some(id as u32)
}
