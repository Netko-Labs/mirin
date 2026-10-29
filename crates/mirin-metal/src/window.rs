//! Window shell: open a GPU-rendered GPUI window that renders a driver-owned
//! element tree, applies streamed tree updates, keeps the editing state of
//! `input` nodes, and reports interaction events.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Duration;

use futures::StreamExt;

use gpui::{
    prelude::*, px, size, App, Application, Bounds, Context, FocusHandle, ScrollHandle,
    SharedString, TitlebarOptions, Window, WindowBounds, WindowOptions,
};

use crate::events::{EventSender, NativeUiEvent};
use crate::list::VirtualList;
use crate::media::MetalAssets;
use crate::pointer::capture_root;
use crate::render::render_node;
use crate::sim::{self, LayoutMap, SimCommand};
use crate::tree::{collect_inputs, collect_scroll_ids, NodeSpec};

/// After a simulated click, how long to wait for the driver's resulting tree
/// before performing the commands queued behind it.
const SIM_SETTLE_INTERVAL: Duration = Duration::from_millis(16);

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

/// What a driver sends to the window.
#[derive(Debug, Clone, PartialEq)]
pub enum DriverMessage {
    /// Replace the rendered tree (last write wins per tick).
    Tree(Box<NodeSpec>),
    /// Simulate input or query layout (`sim.rs`).
    Sim(SimCommand),
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
    /// Ctrl/Cmd+A: the next insertion or deletion replaces the whole buffer.
    pub(crate) select_all: bool,
}

/// The root view: renders whatever tree the driver last sent.
pub(crate) struct RootView {
    /// Shared so each frame can walk it without a deep copy.
    pub(crate) tree: Rc<NodeSpec>,
    pub(crate) events: EventSender,
    pub(crate) inputs: HashMap<String, InputState>,
    /// Bounds of id'd nodes from the last paint, for simulated clicks.
    pub(crate) layout: LayoutMap,
    /// Node currently capturing the pointer (`onPointer`), until release.
    pub(crate) dragging: Option<String>,
    /// Scroll state of scrollable nodes, by id, for programmatic scrolling.
    pub(crate) scrolls: HashMap<String, ScrollHandle>,
    /// Virtualized long lists, by id (`list.rs`).
    pub(crate) lists: HashMap<String, VirtualList>,
}

impl RootView {
    fn new(tree: NodeSpec, events: EventSender, layout: LayoutMap, cx: &mut App) -> Self {
        let mut view = Self {
            tree: Rc::new(tree),
            events,
            inputs: HashMap::new(),
            layout,
            dragging: None,
            scrolls: HashMap::new(),
            lists: HashMap::new(),
        };
        view.sync_inputs(cx);
        crate::list::sync(&mut view.lists, &view.tree);
        view
    }

    /// Replace the tree and reconcile input state with it.
    fn set_tree(&mut self, tree: NodeSpec, cx: &mut App) {
        self.tree = Rc::new(tree);
        self.sync_inputs(cx);
        crate::list::sync(&mut self.lists, &self.tree);
        let mut ids = HashSet::new();
        collect_scroll_ids(&self.tree, &mut ids);
        self.scrolls.retain(|id, _| ids.contains(id));
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
                            select_all: false,
                        },
                    );
                }
            }
        }
        self.inputs.retain(|id, _| seen.contains(id));
    }

    /// Move focus from `from` to the next (`+1`) or previous (`-1`) input in
    /// document order, wrapping around. Tab / Shift+Tab.
    pub(crate) fn focus_neighbor(&mut self, from: &str, step: isize, window: &mut Window) {
        let mut specs = Vec::new();
        collect_inputs(&self.tree, &mut specs);
        let ids: Vec<&str> = specs.iter().map(|spec| spec.id.as_str()).collect();
        let Some(index) = ids.iter().position(|id| *id == from) else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        let len = ids.len() as isize;
        let next = ((index as isize + step) % len + len) % len;
        if let Some(state) = self.inputs.get(ids[next as usize]) {
            window.focus(&state.focus);
        }
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
        // The tree is immutable per frame; hold a reference so input state can
        // be read and listeners attached while walking it.
        let started = std::time::Instant::now();
        self.layout.begin_frame();
        let tree = self.tree.clone();
        let content = render_node(&tree, self, window, cx);
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;
        let root = capture_root(content, cx);
        if !crate::trace::enabled() {
            return root;
        }
        // Painted last, so its paint callback marks the end of GPUI's layout,
        // prepaint, and paint for this frame.
        let size = window.viewport_size();
        let marker = gpui::canvas(
            |_, _, _| {},
            move |_, (), _, _| {
                crate::trace::log(format_args!(
                    "render {:.0}x{:.0} took {render_ms:.2}ms, frame {:.2}ms",
                    f32::from(size.width),
                    f32::from(size.height),
                    started.elapsed().as_secs_f64() * 1000.0
                ));
            },
        )
        .absolute()
        .size_0();
        gpui::div()
            .size_full()
            .child(root)
            .child(marker)
            .into_any_element()
    }
}

/// Open the native window rendering `initial_tree` and hand the calling thread
/// to GPUI's event loop. Blocks until the app quits; call on the process main
/// thread. New trees sent on `updates` replace the rendered tree (last write
/// wins); node interactions are reported on `events`.
pub fn run(
    options: NativeUiOptions,
    initial_tree: NodeSpec,
    updates: mpsc::Receiver<DriverMessage>,
    events: mpsc::Sender<NativeUiEvent>,
) {
    Application::new()
        .with_assets(MetalAssets)
        .run(move |cx: &mut App| {
            let bounds = Bounds::centered(None, size(px(options.width), px(options.height)), cx);
            let window_options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(options.title.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let layout = LayoutMap::default();
            let event_sender = EventSender::new(events, layout.clone());
            let opened = cx.open_window(window_options, |_window, cx| {
                cx.new(|cx| RootView::new(initial_tree, event_sender, layout, cx))
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

            // Driver messages arrive on a std channel from another thread; bridge
            // them into an async channel so the window wakes as soon as one lands
            // instead of polling on a timer.
            let (wake_tx, mut wake_rx) = futures::channel::mpsc::unbounded::<DriverMessage>();
            std::thread::spawn(move || {
                while let Ok(message) = updates.recv() {
                    if wake_tx.unbounded_send(message).is_err() {
                        break;
                    }
                }
            });

            // Apply driver updates, coalescing to the newest tree per wake.
            cx.spawn(async move |cx| {
                // Simulated commands waiting for a later turn: a focus or press must
                // land (and the driver's resulting tree arrive) before the commands
                // after it, so at most one of those is performed per turn.
                let mut pending: VecDeque<SimCommand> = VecDeque::new();
                loop {
                    let mut latest_tree = None;
                    let mut absorb =
                        |message: DriverMessage, pending: &mut VecDeque<SimCommand>| match message {
                            DriverMessage::Tree(tree) => latest_tree = Some(*tree),
                            DriverMessage::Sim(command) => pending.push_back(command),
                        };
                    if pending.is_empty() {
                        match wake_rx.next().await {
                            Some(message) => absorb(message, &mut pending),
                            // The driver went away; the window keeps its last tree.
                            None => return,
                        }
                    } else {
                        cx.background_executor().timer(SIM_SETTLE_INTERVAL).await;
                    }
                    while let Ok(message) = wake_rx.try_recv() {
                        absorb(message, &mut pending);
                    }
                    let mut sims = Vec::new();
                    while let Some(command) = pending.pop_front() {
                        let settles = matches!(command, SimCommand::Click { .. });
                        sims.push(command);
                        if settles {
                            break;
                        }
                    }
                    if latest_tree.is_none() && sims.is_empty() {
                        continue;
                    }
                    // Resolve while the view is leased; dispatch with only the window
                    // leased, because keystrokes re-enter the view's listeners.
                    let resolved = window.update(cx, |view, window, cx| {
                        if let Some(tree) = latest_tree {
                            let started = std::time::Instant::now();
                            view.set_tree(tree, cx);
                            crate::trace::log(format_args!(
                                "tree applied in {:.2}ms",
                                started.elapsed().as_secs_f64() * 1000.0
                            ));
                            view.apply_pending_focus(window);
                            cx.notify();
                        }
                        let actions: Vec<_> = sims
                            .iter()
                            .filter_map(|command| sim::resolve(command, view))
                            .collect();
                        (actions, view.events.clone())
                    });
                    let Ok((actions, events)) = resolved else {
                        // Window is gone; nothing left to drive.
                        return;
                    };
                    if actions.is_empty() {
                        continue;
                    }
                    let any_window: gpui::AnyWindowHandle = window.into();
                    let dispatched = any_window.update(cx, |_root, window, cx| {
                        for action in actions {
                            sim::perform(action, &events, window, cx);
                        }
                    });
                    if dispatched.is_err() {
                        return;
                    }
                }
            })
            .detach();
        });
}
