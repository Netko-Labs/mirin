//! mirin: Dashi's own Wayland protocols, the ones no other compositor has.
//! They are behind the `dashi` cargo feature, so an app for a plain Wayland
//! desktop builds without them. There is one today, `dashi-chrome-v1`:
//!
//! - the unified title bar: a toplevel whose title bar appears transparent
//!   asks Dashi to draw none and to put its traffic lights over the window,
//!   and hears where they are ([`TitleBar`]);
//! - since its version 2, glass: each pane's corner radius and material,
//!   which `ext-background-effect-v1`'s region cannot say ([`GlassPanes`],
//!   sent by `glass.rs`).
//!
//! Without the feature nothing is bound, as on a compositor that lacks the
//! global: the window keeps the standard title bar (xdg-decoration),
//! `chrome_controls` answers `None`, and there is no glass. Layer surfaces (wlr-layer-shell),
//! session lock (ext-session-lock-v1) and drags (wl_data_device) are
//! standard or wlr protocols and are not here.

#[cfg(feature = "dashi")]
mod chrome;

pub(super) use title_bar::{ChromeManager, GlassPanes, TitleBar, bind_chrome_manager};

#[cfg(feature = "dashi")]
mod title_bar {
    use sumi::{Bounds, px, size};
    use wayland_backend::client::ObjectId;
    use wayland_client::globals::GlobalList;
    use wayland_client::protocol::wl_surface::WlSurface;
    use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, delegate_noop};
    use wayland_protocols::xdg::shell::client::xdg_toplevel::XdgToplevel;

    use super::chrome::{dashi_chrome_manager_v1, dashi_chrome_v1, dashi_glass_v1};
    use crate::linux::{WaylandClientStatePtr, get_window};

    /// Dashi's `dashi_chrome_manager_v1` global; `None` on every other
    /// compositor.
    pub(in crate::linux::wayland) type ChromeManager =
        dashi_chrome_manager_v1::DashiChromeManagerV1;

    /// Version 1 has the title bar; version 2 adds glass.
    pub(in crate::linux::wayland) fn bind_chrome_manager(
        globals: &GlobalList,
        qh: &QueueHandle<WaylandClientStatePtr>,
    ) -> Option<ChromeManager> {
        globals.bind(qh, 1..=2, ()).ok()
    }

    /// A surface's panes of glass (`dashi_glass_v1`): their radius and
    /// material, double-buffered like the blur region that goes with them.
    pub(in crate::linux::wayland) struct GlassPanes(dashi_glass_v1::DashiGlassV1);

    impl GlassPanes {
        /// The glass object of `surface`, when the manager is version 2 or
        /// later (an older Dashi has no glass).
        pub(in crate::linux::wayland) fn get(
            manager: &ChromeManager,
            surface: &WlSurface,
            qh: &QueueHandle<WaylandClientStatePtr>,
        ) -> Option<Self> {
            (manager.version() >= dashi_chrome_manager_v1::REQ_GET_GLASS_SINCE)
                .then(|| Self(manager.get_glass(surface, qh, ())))
        }

        /// Sets the panes, packed as the protocol says (`glass::pack`).
        pub(in crate::linux::wayland) fn set(&self, packed: Vec<u8>) {
            self.0.set_panes(packed);
        }

        pub(in crate::linux::wayland) fn destroy(&self) {
            self.0.destroy();
        }
    }

    // mirin reads no `tone` yet (the words' colour leaning to the backdrop
    // is the app's, later).
    delegate_noop!(WaylandClientStatePtr: ignore dashi_glass_v1::DashiGlassV1);

    /// A toplevel's unified title bar: no compositor title bar, its traffic
    /// lights over the window. It lives with the toplevel and is destroyed
    /// before it.
    pub(in crate::linux::wayland) struct TitleBar(dashi_chrome_v1::DashiChromeV1);

    impl TitleBar {
        /// Asks for the unified style; before the toplevel's first commit, so
        /// the window opens placed for it.
        pub(in crate::linux::wayland) fn unified(
            manager: &ChromeManager,
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
    use wayland_client::protocol::wl_surface::WlSurface;
    use wayland_protocols::xdg::shell::client::xdg_toplevel::XdgToplevel;

    use crate::linux::WaylandClientStatePtr;

    #[derive(Clone)]
    pub(in crate::linux::wayland) enum ChromeManager {}

    pub(in crate::linux::wayland) fn bind_chrome_manager(
        _globals: &GlobalList,
        _qh: &QueueHandle<WaylandClientStatePtr>,
    ) -> Option<ChromeManager> {
        None
    }

    pub(in crate::linux::wayland) enum GlassPanes {}

    impl GlassPanes {
        pub(in crate::linux::wayland) fn get(
            manager: &ChromeManager,
            _surface: &WlSurface,
            _qh: &QueueHandle<WaylandClientStatePtr>,
        ) -> Option<Self> {
            match *manager {}
        }

        pub(in crate::linux::wayland) fn set(&self, _packed: Vec<u8>) {
            match *self {}
        }

        pub(in crate::linux::wayland) fn destroy(&self) {
            match *self {}
        }
    }

    pub(in crate::linux::wayland) enum TitleBar {}

    impl TitleBar {
        pub(in crate::linux::wayland) fn unified(
            manager: &ChromeManager,
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
