//! mirin: Dashi's own Wayland protocols, the ones no other compositor has.
//! They are behind the `dashi` cargo feature, so an app for a plain Wayland
//! desktop builds without them. There is one today:
//!
//! - `dashi-chrome-v1`, the unified title bar: a toplevel whose title bar
//!   appears transparent asks Dashi to draw none and to put its traffic
//!   lights over the window, and hears where they are ([`TitleBar`]).
//!
//! Without the feature nothing is bound, as on a compositor that lacks the
//! global: the window keeps the standard title bar (xdg-decoration) and
//! `chrome_controls` answers `None`. Layer surfaces (wlr-layer-shell),
//! session lock (ext-session-lock-v1) and drags (wl_data_device) are
//! standard or wlr protocols and are not here.

#[cfg(feature = "dashi")]
mod chrome;

pub(super) use title_bar::{TitleBar, TitleBarManager, bind_title_bar_manager};

#[cfg(feature = "dashi")]
mod title_bar {
    use sumi::{Bounds, px, size};
    use wayland_backend::client::ObjectId;
    use wayland_client::globals::GlobalList;
    use wayland_client::{Connection, Dispatch, QueueHandle, delegate_noop};
    use wayland_protocols::xdg::shell::client::xdg_toplevel::XdgToplevel;

    use super::chrome::{dashi_chrome_manager_v1, dashi_chrome_v1};
    use crate::linux::{WaylandClientStatePtr, get_window};

    /// Dashi's `dashi_chrome_manager_v1` global; `None` on every other
    /// compositor.
    pub(in crate::linux::wayland) type TitleBarManager =
        dashi_chrome_manager_v1::DashiChromeManagerV1;

    pub(in crate::linux::wayland) fn bind_title_bar_manager(
        globals: &GlobalList,
        qh: &QueueHandle<WaylandClientStatePtr>,
    ) -> Option<TitleBarManager> {
        globals.bind(qh, 1..=1, ()).ok()
    }

    /// A toplevel's unified title bar: no compositor title bar, its traffic
    /// lights over the window. It lives with the toplevel and is destroyed
    /// before it.
    pub(in crate::linux::wayland) struct TitleBar(dashi_chrome_v1::DashiChromeV1);

    impl TitleBar {
        /// Asks for the unified style; before the toplevel's first commit, so
        /// the window opens placed for it.
        pub(in crate::linux::wayland) fn unified(
            manager: &TitleBarManager,
            toplevel: &XdgToplevel,
            qh: &QueueHandle<WaylandClientStatePtr>,
            surface: ObjectId,
        ) -> Self {
            let chrome = manager.get_chrome(toplevel, qh, surface);
            chrome.set_style(dashi_chrome_v1::Style::Unified);
            Self(chrome)
        }

        pub(in crate::linux::wayland) fn destroy(&self) {
            self.0.destroy();
        }
    }

    delegate_noop!(WaylandClientStatePtr: ignore dashi_chrome_manager_v1::DashiChromeManagerV1);

    // The compositor tells where its traffic lights are (`controls`); an
    // empty rectangle means none (standard style, or unified was not honored).
    impl Dispatch<dashi_chrome_v1::DashiChromeV1, ObjectId> for WaylandClientStatePtr {
        fn event(
            this: &mut Self,
            _: &dashi_chrome_v1::DashiChromeV1,
            event: dashi_chrome_v1::Event,
            surface_id: &ObjectId,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            let client = this.get_client();
            let mut state = client.borrow_mut();
            let Some(window) = get_window(&mut state, surface_id) else {
                return;
            };
            drop(state);
            let dashi_chrome_v1::Event::Controls {
                x,
                y,
                width,
                height,
            } = event;
            window.set_chrome_controls((width > 0 && height > 0).then(|| Bounds {
                origin: sumi::point(px(x as f32), px(y as f32)),
                size: size(px(width as f32), px(height as f32)),
            }));
        }
    }
}

/// Without the `dashi` feature: the same names, never made, so the window
/// and the client need no condition of their own.
#[cfg(not(feature = "dashi"))]
mod title_bar {
    use wayland_backend::client::ObjectId;
    use wayland_client::QueueHandle;
    use wayland_client::globals::GlobalList;
    use wayland_protocols::xdg::shell::client::xdg_toplevel::XdgToplevel;

    use crate::linux::WaylandClientStatePtr;

    #[derive(Clone)]
    pub(in crate::linux::wayland) enum TitleBarManager {}

    pub(in crate::linux::wayland) fn bind_title_bar_manager(
        _globals: &GlobalList,
        _qh: &QueueHandle<WaylandClientStatePtr>,
    ) -> Option<TitleBarManager> {
        None
    }

    pub(in crate::linux::wayland) enum TitleBar {}

    impl TitleBar {
        pub(in crate::linux::wayland) fn unified(
            manager: &TitleBarManager,
            _toplevel: &XdgToplevel,
            _qh: &QueueHandle<WaylandClientStatePtr>,
            _surface: ObjectId,
        ) -> Self {
            match *manager {}
        }

        pub(in crate::linux::wayland) fn destroy(&self) {
            match *self {}
        }
    }
}
