//! Root window: open a GPU-rendered GPUI window hosting the mirin root view.

use gpui::{
    div, prelude::*, px, rgb, size, App, Application, Bounds, Context, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowOptions,
};

/// Options for the alpha native-UI window. All fields have sensible defaults.
#[derive(Debug, Clone)]
pub struct NativeUiOptions {
    pub title: SharedString,
    pub width: f32,
    pub height: f32,
}

impl Default for NativeUiOptions {
    fn default() -> Self {
        Self {
            title: "mirin native (alpha)".into(),
            width: 800.0,
            height: 600.0,
        }
    }
}

/// The placeholder root view rendered while the crate is a windowing spike.
struct RootView {
    title: SharedString,
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_2()
            .size_full()
            .bg(rgb(0x111114))
            .text_color(rgb(0xf4f4f5))
            .child(div().text_2xl().child(self.title.clone()))
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0x9f9fa8))
                    .child("GPU-rendered by GPUI — no web engine in this window"),
            )
    }
}

/// Open the native window and hand the calling thread to GPUI's event loop.
/// Blocks until the app quits. Call on the process main thread.
pub fn run(options: NativeUiOptions) {
    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(options.width), px(options.height)), cx);
        let window_options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(options.title.clone()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let title = options.title.clone();
        let opened = cx.open_window(window_options, |_window, cx| cx.new(|_| RootView { title }));
        match opened {
            Ok(_handle) => cx.activate(true),
            Err(error) => {
                eprintln!("[mirin-native] failed to open window: {error}");
                cx.quit();
            }
        }
    });
}
