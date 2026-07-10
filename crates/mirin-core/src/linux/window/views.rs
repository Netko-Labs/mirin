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
                String::new(),
                0,
                0,
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

// Top-level window delegate: attaches the browser view, sizes/shows the window,
// and routes close through the browser.
wrap_window_delegate! {
    pub struct MirinWindowDelegate {
        browser_view: RefCell<Option<BrowserView>>,
        title: String,
        width: i32,
        height: i32,
        show: bool,
        always_on_top: bool,
        frameless: bool,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: self.width.max(1), height: self.height.max(1) }
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
            if self.width > 0 && self.height > 0 {
                window.center_window(Some(&Size { width: self.width, height: self.height }));
            }
            if self.always_on_top {
                window.set_always_on_top(1);
            }
            if self.show {
                window.show();
                window.activate();
            }
            install_window_props(window.window_handle() as u64);
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
