//! The `gpui-next` build: upstream GPUI (`forks/zed`). Items marked `GAP` are
//! stand-ins for fork features not yet ported to `forks/zed` (the feature is
//! off, or does less); each is a row of docs/metal/gpui-next.md.

use std::path::{Path, PathBuf};

use gpui::{
    px, App, Application, AsyncApp, Bounds, BoxShadow, FocusHandle, Hsla, Keystroke, ListState,
    Pixels, Point, ScrollHandle, ShapedLine, Size, StyledText, Subscription, TextLayout, Window,
    WindowKind, WindowOptions,
};

pub(crate) use gpui::layer_shell::{KeyboardInteractivity, Layer};
pub(crate) use gpui::ScrollEvent as ScrollWheelEvent;

/// The application, on the platform GPUI picks, with GPUI's own AccessKit
/// adapter off: mirin's `access/` tree is the one screen readers get (it is
/// incremental and survives retained subtrees, which GPUI's is not and does
/// not), so GPUI's would only publish a second, empty application
/// (docs/metal/gpui-next.md, "Round 5: a small app's footprint").
pub(crate) fn application() -> Application {
    Application::new_inaccessible(gpui_platform::current_platform(false))
}

/// The event loop goes on when the last window closes (a resident host hides it).
pub(crate) fn keep_running_without_windows(cx: &mut App) {
    cx.set_quit_mode(gpui::QuitMode::Explicit);
}

/// Run `callback` whenever a window closes.
pub(crate) fn on_window_closed(
    cx: &mut App,
    mut callback: impl FnMut(&mut App) + 'static,
) -> Subscription {
    cx.on_window_closed(move |cx, _window| callback(cx))
}

/// `AsyncApp::update`: `None` when the app is gone (never, upstream).
pub(crate) fn update<R>(cx: &mut AsyncApp, update: impl FnOnce(&mut App) -> R) -> Option<R> {
    Some(cx.update(update))
}

/// Give `handle` the keyboard.
pub(crate) fn focus(window: &mut Window, handle: &FocusHandle, cx: &mut App) {
    window.focus(handle, cx);
}

/// How far a scroll view can scroll.
pub(crate) fn scroll_max(handle: &ScrollHandle) -> Size<Pixels> {
    let max = handle.max_offset();
    gpui::size(max.x, max.y)
}

/// How far a list can scroll, for its scroll bar.
pub(crate) fn list_scroll_max(state: &ListState) -> Size<Pixels> {
    let max = state.max_offset_for_scrollbar();
    gpui::size(max.x, max.y)
}

/// Paint a shaped line from its left edge.
pub(crate) fn paint_line(
    line: &ShapedLine,
    origin: Point<Pixels>,
    line_height: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Result<()> {
    line.paint(origin, line_height, gpui::TextAlign::Left, None, window, cx)
}

/// An outer box shadow.
pub(crate) fn box_shadow(
    color: Hsla,
    offset: Point<Pixels>,
    blur_radius: Pixels,
    spread_radius: Pixels,
) -> BoxShadow {
    BoxShadow {
        color,
        offset,
        blur_radius,
        spread_radius,
        inset: false,
    }
}

/// A keystroke from its text (`"cmd-a"`); upstream's `parse` takes only a
/// `&'static str`, dynamic text names the platform.
pub(crate) fn parse_keystroke(source: &str) -> Result<Keystroke, impl std::fmt::Debug> {
    let os = if cfg!(target_os = "macos") {
        gpui::OperatingSystem::Mac
    } else if cfg!(target_os = "windows") {
        gpui::OperatingSystem::Windows
    } else {
        gpui::OperatingSystem::Linux
    };
    Keystroke::parse_with_os(source, os)
}

/// `on_scroll` (upstream's name for `on_scroll_wheel`).
pub(crate) fn on_wheel<E: gpui::InteractiveElement>(
    element: E,
    listener: impl Fn(&ScrollWheelEvent, &mut Window, &mut App) + 'static,
) -> E {
    element.on_scroll(listener)
}

/// The fork's layer anchor; upstream's is a bitflags set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayerAnchor {
    pub top: bool,
    pub bottom: bool,
    pub left: bool,
    pub right: bool,
}

/// The fork's layer margins; upstream's are a tuple of `Pixels`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayerMargin {
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub left: i32,
}

/// The fork's layer-shell options, made upstream's `WindowKind::LayerShell`
/// by [`with_surface`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerShellOptions {
    pub namespace: String,
    pub layer: Layer,
    pub anchor: LayerAnchor,
    pub exclusive_zone: i32,
    pub margin: LayerMargin,
    pub keyboard_interactivity: KeyboardInteractivity,
    /// GAP: upstream picks the screen by `WindowOptions::display_id`, and a
    /// `PlatformDisplay` has no connector name to match; the compositor picks.
    pub output: Option<String>,
}

impl LayerShellOptions {
    fn window_kind(&self) -> WindowKind {
        use gpui::layer_shell::Anchor;
        let mut anchor = Anchor::empty();
        anchor.set(Anchor::TOP, self.anchor.top);
        anchor.set(Anchor::BOTTOM, self.anchor.bottom);
        anchor.set(Anchor::LEFT, self.anchor.left);
        anchor.set(Anchor::RIGHT, self.anchor.right);
        WindowKind::LayerShell(gpui::layer_shell::LayerShellOptions {
            namespace: self.namespace.clone(),
            layer: self.layer,
            anchor,
            exclusive_zone: Some(px(self.exclusive_zone as f32)),
            exclusive_edge: None,
            margin: Some((
                px(self.margin.top as f32),
                px(self.margin.right as f32),
                px(self.margin.bottom as f32),
                px(self.margin.left as f32),
            )),
            keyboard_interactivity: self.keyboard_interactivity,
        })
    }
}

/// The window's surface role: a layer surface or the lock screen; neither, a
/// toplevel. GAP: no session lock upstream; a lock surface opens as a window.
pub(crate) fn with_surface(
    options: WindowOptions,
    layer: Option<&LayerShellOptions>,
    lock: bool,
) -> WindowOptions {
    let _ = lock;
    WindowOptions {
        kind: layer.map_or(WindowKind::Normal, LayerShellOptions::window_kind),
        ..options
    }
}

/// Whether the compositor shows the window, now and on every change
/// (upstream reports xdg_toplevel's `suspended` as its visibility).
pub(crate) fn observe_visibility(window: &mut Window, mut callback: impl FnMut(bool) + 'static) {
    window
        .observe_window_visibility(move |visibility, _window, _cx| {
            callback(visibility.is_visible())
        })
        .detach();
}

/// GAP: no `dashi_chrome_manager_v1` upstream: the unified style is never
/// granted, so the controls are reported once, as none.
pub(crate) fn observe_chrome(
    _window: &mut Window,
    mut callback: impl FnMut(Option<Bounds<Pixels>>) + 'static,
) {
    callback(None);
}

/// GAP: no session lock upstream; there is nothing to unlock.
pub(crate) fn unlock_session(_window: &mut Window) {}

/// Upstream always paints scroll views at whole device pixels
/// (`Window::layout_bounds` snaps the element offset, halves toward zero);
/// the switch to paint them at their offset (`MIRIN_METAL_SCROLL_SNAP=0`) is
/// the fork's alone.
pub(crate) fn set_scroll_snap(_window: &mut Window, _snap: bool) {}

/// GAP: upstream's drag-out (`external_drag_payload`) has another shape and
/// no icon; this build can't start one.
pub(crate) fn start_file_drag(
    _window: &Window,
    _paths: &[PathBuf],
    _icon: Option<&Path>,
    _icon_size: u32,
) -> bool {
    false
}

/// GAP: upstream shapes a text at one size; every paragraph takes the text's.
pub(crate) fn with_paragraph_sizes(text: StyledText, _sizes: Vec<Option<Pixels>>) -> StyledText {
    text
}

/// GAP: one line height for the whole text upstream.
pub(crate) fn line_height_at(layout: &TextLayout, _index: usize) -> Pixels {
    layout.line_height()
}

/// Draw the window's next frame and drop it (tests).
#[cfg(test)]
pub(crate) fn draw(window: &mut Window, cx: &mut App) {
    window.draw(cx).clear(cx);
}

/// GAP: upstream's list does not say where it paints its content, so its rows
/// stay in the group around it and each moves on its own (`list.rs`).
pub(crate) const LIST_CONTENT_ORIGIN: bool = false;

/// GAP: never called upstream (`LIST_CONTENT_ORIGIN` is false).
pub(crate) fn on_list_content_origin(
    list: gpui::List,
    _listener: impl Fn(Point<Pixels>, &mut Window, &mut App) + 'static,
) -> gpui::List {
    list
}

/// GAP: upstream's scene traces have no glyph variants; this does nothing.
pub(crate) fn describe_glyph_variants(_on: bool) {}

/// GAP: upstream's retained subtrees are copied in place only; one that was
/// resized is drawn again, so this changes nothing.
pub(crate) fn stretchable(retained: gpui::Retained, _stretchable: bool) -> gpui::Retained {
    retained
}
