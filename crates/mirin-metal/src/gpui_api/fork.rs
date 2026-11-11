//! The default build: mirin's fork of gpui 0.2.2 (`forks/gpui`).

use std::path::{Path, PathBuf};

use gpui::{
    App, Application, AsyncApp, Bounds, BoxShadow, FocusHandle, Hsla, Keystroke, ListState, Pixels,
    Point, ScrollHandle, ShapedLine, Size, StyledText, Subscription, TextLayout, Window,
    WindowOptions,
};

pub(crate) use gpui::{
    KeyboardInteractivity, Layer, LayerAnchor, LayerMargin, LayerShellOptions, ScrollWheelEvent,
};

/// The application, on the platform GPUI picks.
pub(crate) fn application() -> Application {
    Application::new()
}

/// The event loop goes on when the last window closes (a resident host hides it).
pub(crate) fn keep_running_without_windows(_cx: &mut App) {
    gpui::set_quit_when_last_window_closes(false);
}

/// Run `callback` whenever a window closes.
pub(crate) fn on_window_closed(
    cx: &mut App,
    mut callback: impl FnMut(&mut App) + 'static,
) -> Subscription {
    cx.on_window_closed(move |cx| callback(cx))
}

/// `AsyncApp::update`: `None` when the app is gone.
pub(crate) fn update<R>(cx: &mut AsyncApp, update: impl FnOnce(&mut App) -> R) -> Option<R> {
    cx.update(update).ok()
}

/// Give `handle` the keyboard.
pub(crate) fn focus(window: &mut Window, handle: &FocusHandle, _cx: &mut App) {
    window.focus(handle);
}

/// How far a scroll view can scroll.
pub(crate) fn scroll_max(handle: &ScrollHandle) -> Size<Pixels> {
    handle.max_offset()
}

/// How far a list can scroll, for its scroll bar.
pub(crate) fn list_scroll_max(state: &ListState) -> Size<Pixels> {
    state.max_offset_for_scrollbar()
}

/// Paint a shaped line from its left edge.
pub(crate) fn paint_line(
    line: &ShapedLine,
    origin: Point<Pixels>,
    line_height: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Result<()> {
    line.paint(origin, line_height, window, cx)
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
    }
}

/// A keystroke from its text (`"cmd-a"`).
pub(crate) fn parse_keystroke(source: &str) -> Result<Keystroke, impl std::fmt::Debug> {
    Keystroke::parse(source)
}

/// `on_scroll_wheel`.
pub(crate) fn on_wheel<E: gpui::InteractiveElement>(
    element: E,
    listener: impl Fn(&ScrollWheelEvent, &mut Window, &mut App) + 'static,
) -> E {
    element.on_scroll_wheel(listener)
}

/// The window's surface role: a layer surface or the lock screen; neither, a toplevel.
pub(crate) fn with_surface(
    options: WindowOptions,
    layer: Option<&LayerShellOptions>,
    lock: bool,
) -> WindowOptions {
    WindowOptions {
        layer_shell: layer.cloned(),
        session_lock: lock,
        ..options
    }
}

/// Whether the compositor shows the window, now and on every change.
pub(crate) fn observe_visibility(window: &mut Window, mut callback: impl FnMut(bool) + 'static) {
    window
        .observe_window_suspended(move |window, _cx| callback(!window.is_window_suspended()))
        .detach();
}

/// Where the compositor draws its window controls over a unified title bar
/// (Dashi), now and on every change.
pub(crate) fn observe_chrome(
    window: &mut Window,
    mut callback: impl FnMut(Option<Bounds<Pixels>>) + 'static,
) {
    window
        .observe_window_chrome(move |window, _cx| callback(window.chrome_controls()))
        .detach();
}

/// Unlock the session a lock surface holds.
pub(crate) fn unlock_session(window: &mut Window) {
    window.unlock_session();
}

/// Change the window's least size after it opened.
pub(crate) fn set_min_size(window: &mut Window, size: Size<Pixels>) {
    window.set_window_min_size(size);
}

/// Paint scroll views at whole device pixels.
pub(crate) fn set_scroll_snap(window: &mut Window, snap: bool) {
    window.set_scroll_snap(snap);
}

/// Start dragging files out of the window; false when the platform can't.
pub(crate) fn start_file_drag(
    window: &Window,
    paths: &[PathBuf],
    icon: Option<&Path>,
    icon_size: u32,
) -> bool {
    window.start_file_drag(paths, icon, icon_size)
}

/// Shape each paragraph of a text at its own size (`None`: the text's).
pub(crate) fn with_paragraph_sizes(text: StyledText, sizes: Vec<Option<Pixels>>) -> StyledText {
    text.with_paragraph_sizes(sizes)
}

/// The height of the line that holds `index`.
pub(crate) fn line_height_at(layout: &TextLayout, index: usize) -> Pixels {
    layout.line_height_for_index(index)
}

/// Draw the window's next frame and drop it (tests).
#[cfg(test)]
pub(crate) fn draw(window: &mut Window, cx: &mut App) {
    window.draw(cx).clear();
}
