//! Linux (X11/Ozone) native layer. Unlike `mac/` (CEF paints into a mirin-owned
//! NSView) and `win/` (CEF child HWND under a mirin-owned top-level window), the
//! Linux port doesn't own a native toolkit window: the primary window uses CEF's
//! **Views** framework — CEF owns a real X11 toplevel hosting a BrowserView
//! (`window.rs`). Ozone is forced to X11 (`--ozone-platform=x11`, override via
//! `MIRIN_OZONE`); on a Wayland session this runs under XWayland. This mirrors
//! Electrobun and replaces the earlier Wayland-native/OSR plan (dropped: cosmic-comp
//! draws server-side decorations with no CEF client-side-decoration lever, so a
//! borderless custom title bar was impossible on native Wayland, and the OSR
//! fallback was laggy with HiDPI scaling bugs). X11 + `is_frameless` yields a truly
//! borderless, GPU-rendered window. Window management (move/resize/live-resize,
//! maximize/fullscreen/always-on-top, `WM_CLASS` + `_NET_WM_ICON`) is done via Xlib
//! against the CEF window's XID — see `window.rs`.
//!
//! App-shell features (menu/tray/dialog/clipboard/shortcut) are handled by
//! the engine's `not(any(macos, windows))` fallback arms for now and grow into
//! dedicated submodules here as the port reaches the L4 milestone
//! (`docs/linux-port.md`).

pub mod window;

pub use window::{
    close_all_windows, close_window, control, maybe_start_drag, register_window,
    set_draggable_regions, set_position, set_window_title, tag_browser_view, window_id_for_browser,
    MirinBrowserViewDelegate, MirinWindowDelegate,
};
