//! Window shell: open a GPU-rendered GPUI window that renders a driver-owned
//! element tree, applies streamed tree updates, keeps the editing state of
//! `input` nodes, and reports interaction events.

use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use gpui::{
    prelude::*, px, size, App, Application, Bounds, Context, FocusHandle, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowOptions,
};

use crate::events::{EventSender, NativeUiEvent};
use crate::render::render_node;
use crate::tree::{collect_inputs, NodeSpec};

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
            title: "mirin metal (alpha)".into(),
            width: 800.0,
            height: 600.0,
        }
    }
}

/// Renderer-owned editing state of one `input` node.
pub(crate) struct InputState {
    pub(crate) focus: FocusHandle,
    pub(crate) buffer: String,
    /// Caret position as a char index into `buffer`.
    pub(crate) cursor: usize,
    /// The driver's `value` the buffer was last synced from; a different value
    /// in a new tree resets the buffer (controlled-input semantics).
    pub(crate) synced_value: String,
    /// Set by the tree sync when the node is new and asked for `autofocus`.
    pub(crate) wants_focus: bool,
}

/// The root view: renders whatever tree the driver last sent.
pub(crate) struct RootView {
    pub(crate) tree: NodeSpec,
    pub(crate) events: EventSender,
    pub(crate) inputs: HashMap<String, InputState>,
}

impl RootView {
    fn new(tree: NodeSpec, events: EventSender, cx: &mut App) -> Self {
        let mut view = Self {
            tree,
            events,
            inputs: HashMap::new(),
        };
        view.sync_inputs(cx);
        view
    }

    /// Replace the tree and reconcile input state with it.
    fn set_tree(&mut self, tree: NodeSpec, cx: &mut App) {
        self.tree = tree;
        self.sync_inputs(cx);
    }

    /// Create state for new inputs, reset buffers whose driver value changed,
    /// and drop state for inputs that left the tree.
    fn sync_inputs(&mut self, cx: &mut App) {
        let mut specs = Vec::new();
        collect_inputs(&self.tree, &mut specs);
        let mut seen = Vec::with_capacity(specs.len());
        for spec in specs {
            seen.push(spec.id.clone());
            match self.inputs.get_mut(&spec.id) {
                Some(state) => {
                    if state.synced_value != spec.value {
                        state.buffer = spec.value.clone();
                        state.cursor = state.buffer.chars().count();
                        state.synced_value = spec.value.clone();
                    }
                }
                None => {
                    self.inputs.insert(
                        spec.id.clone(),
                        InputState {
                            focus: cx.focus_handle(),
                            cursor: spec.value.chars().count(),
                            buffer: spec.value.clone(),
                            synced_value: spec.value.clone(),
                            wants_focus: spec.autofocus,
                        },
                    );
                }
            }
        }
        self.inputs.retain(|id, _| seen.contains(id));
    }

    /// Honour pending `autofocus` requests. Runs outside of rendering.
    fn apply_pending_focus(&mut self, window: &mut Window) {
        for state in self.inputs.values_mut() {
            if state.wants_focus {
                state.wants_focus = false;
                window.focus(&state.focus);
            }
        }
    }
}

impl Render for RootView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The tree is immutable per frame; clone it so input state can be read
        // and listeners attached while walking it.
        let tree = self.tree.clone();
        render_node(&tree, self, window, cx)
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
            cx.new(|cx| RootView::new(initial_tree, event_sender, cx))
        });
        let window = match opened {
            Ok(window) => window,
            Err(error) => {
                eprintln!("[mirin-metal] failed to open window: {error}");
                cx.quit();
                return;
            }
        };
        cx.activate(true);
        let _ = window.update(cx, |view, window, _cx| view.apply_pending_focus(window));

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
                let applied = window.update(cx, |view, window, cx| {
                    view.set_tree(tree, cx);
                    view.apply_pending_focus(window);
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
