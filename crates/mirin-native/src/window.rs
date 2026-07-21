//! Window shell: open a GPU-rendered GPUI window that renders a driver-owned
//! element tree, applies streamed tree updates, and reports interaction events.

use std::sync::mpsc;
use std::time::Duration;

use gpui::{
    prelude::*, px, size, App, Application, Bounds, Context, SharedString, TitlebarOptions, Window,
    WindowBounds, WindowOptions,
};

use crate::events::{EventSender, NativeUiEvent};
use crate::render::render_node;
use crate::tree::NodeSpec;

/// How often the update task drains the driver's tree channel.
const UPDATE_POLL_INTERVAL: Duration = Duration::from_millis(16);

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

/// The root view: renders whatever tree the driver last sent.
struct RootView {
    tree: NodeSpec,
    events: EventSender,
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        render_node(&self.tree, &self.events)
    }
}

/// Open the native window rendering `initial_tree` and hand the calling thread
/// to GPUI's event loop. Blocks until the app quits; call on the process main
/// thread. New trees sent on `updates` replace the rendered tree (last write
/// wins); node interactions are reported on `events`.
pub fn run(
    options: NativeUiOptions,
    initial_tree: NodeSpec,
    updates: mpsc::Receiver<NodeSpec>,
    events: mpsc::Sender<NativeUiEvent>,
) {
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
        let event_sender = EventSender::new(events);
        let opened = cx.open_window(window_options, |_window, cx| {
            cx.new(|_| RootView {
                tree: initial_tree,
                events: event_sender,
            })
        });
        let window = match opened {
            Ok(window) => window,
            Err(error) => {
                eprintln!("[mirin-native] failed to open window: {error}");
                cx.quit();
                return;
            }
        };
        cx.activate(true);

        // Apply driver updates: poll the channel on the foreground executor and
        // swap the root tree (coalescing to the newest one) when it changes.
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(UPDATE_POLL_INTERVAL).await;
                let mut latest = None;
                while let Ok(tree) = updates.try_recv() {
                    latest = Some(tree);
                }
                let Some(tree) = latest else { continue };
                let applied = window.update(cx, |view, _window, cx| {
                    view.tree = tree;
                    cx.notify();
                });
                if applied.is_err() {
                    // Window is gone; nothing left to drive.
                    return;
                }
            }
        })
        .detach();
    });
}
