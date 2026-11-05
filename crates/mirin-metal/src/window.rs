//! Window shell: open a GPU-rendered GPUI window that renders a driver-owned
//! element tree, applies streamed tree updates, keeps the editing state of
//! `input` nodes, and reports interaction events.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use gpui::{prelude::*, App, Context, FocusHandle, ScrollHandle, SharedString, Window};

use crate::events::EventSender;
use crate::height::Heights;
use crate::list::VirtualList;
use crate::pointer::capture_root;
use crate::render::render_node;
use crate::sim::{LayoutMap, SimCommand};
use crate::surface::Surface;
use crate::titlebar::TitleBar;
use crate::tree::{collect_inputs, collect_key_ids, collect_scroll_ids, NodeSpec};

/// Options for the alpha native-UI window. All fields have sensible defaults.
#[derive(Debug, Clone)]
pub struct NativeUiOptions {
    pub title: SharedString,
    /// The app id compositors group windows by (a dock's icon, a taskbar
    /// entry); usually reverse-DNS, like the manifest `id`.
    pub app_id: Option<String>,
    pub width: f32,
    pub height: f32,
    /// Open as a layer-shell surface (a panel, a dock) or a session-lock
    /// surface instead of a window; see `parse_surface`. A layer surface is
    /// transparent where the tree is; a lock surface is opaque.
    pub surface: Option<Surface>,
    /// `Unified` runs the tree up to the window's top edge where the
    /// compositor supports it (see `titlebar.rs`); ignored for surfaces.
    pub title_bar: TitleBar,
}

impl Default for NativeUiOptions {
    fn default() -> Self {
        Self {
            title: "mirin metal (alpha)".into(),
            app_id: None,
            width: 800.0,
            height: 600.0,
            surface: None,
            title_bar: TitleBar::Standard,
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
    /// Unlock the session this lock surface locked, then quit
    /// (`{"unlock": true}`; the only way a lock surface unlocks).
    Unlock,
    /// Retitle the window (`{"title": "..."}`): what the compositor's title
    /// bar, the window switcher, and the taskbar show.
    Title(String),
}

/// Whether a new driver `value` resets the buffer. A value the renderer sent
/// itself (a late echo, possibly skipping older ones) does not; anything else
/// does, and forgets the pending echoes.
pub(crate) fn driver_resets(echoes: &mut VecDeque<String>, value: &str) -> bool {
    match echoes.iter().position(|sent| sent == value) {
        Some(echoed) => {
            echoes.drain(..=echoed);
            false
        }
        None => {
            echoes.clear();
            true
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
    /// Buffers sent as `change` events that the driver hasn't echoed back
    /// yet, oldest first. A driver value matching one is that echo arriving
    /// late, not a reset: typing faster than the round trip must not lose
    /// keystrokes.
    pub(crate) echoes: VecDeque<String>,
    /// The driver's `revision` the buffer was last reset at.
    pub(crate) revision: u64,
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
    /// A descendant of a drag region took the current left press (a button,
    /// an input), so the region must not start moving the window. Reset on
    /// every press before it dispatches; deeper nodes handle it first.
    pub(crate) press_claimed: bool,
    /// Scroll state of scrollable nodes, by id, for programmatic scrolling.
    pub(crate) scrolls: HashMap<String, ScrollHandle>,
    /// When each scrollable node last scrolled, for its auto-hiding scroll bar (`scrollbar.rs`).
    pub(crate) scroll_activity: HashMap<String, crate::scrollbar::Activity>,
    /// Virtualized long lists, by id (`list.rs`).
    pub(crate) lists: HashMap<String, VirtualList>,
    /// Views that take raw keys (`onKeyDown`), by id.
    pub(crate) key_targets: HashMap<String, KeyTarget>,
    /// A left press on a view with `dragFiles`, and where: moving far enough
    /// with the button held starts the drag (`drag.rs`).
    pub(crate) drag_candidate: Option<(String, gpui::Point<gpui::Pixels>)>,
    /// The `onDrop` view files are being dragged over.
    pub(crate) drop_target: Option<String>,
    /// Views with `heightTransitionMs`: the height each is painted at (`height.rs`).
    pub(crate) heights: Heights,
    /// Until this window's first paint, which is reported (`frame`).
    first_frame: bool,
}

/// A view with `onKeyDown`: its focus, and whether it still has to take it.
pub(crate) struct KeyTarget {
    pub(crate) focus: FocusHandle,
    pub(crate) wants_focus: bool,
}

impl RootView {
    pub(crate) fn new(
        tree: NodeSpec,
        events: EventSender,
        layout: LayoutMap,
        cx: &mut App,
    ) -> Self {
        let mut view = Self {
            tree: Rc::new(tree),
            events,
            inputs: HashMap::new(),
            layout,
            dragging: None,
            press_claimed: false,
            scrolls: HashMap::new(),
            scroll_activity: HashMap::new(),
            lists: HashMap::new(),
            key_targets: HashMap::new(),
            drag_candidate: None,
            drop_target: None,
            heights: Heights::default(),
            first_frame: true,
        };
        view.sync_inputs(cx);
        view.sync_key_targets(cx);
        crate::list::sync(&mut view.lists, &view.tree);
        view.heights.sync(&view.tree);
        view
    }

    /// Replace the tree and reconcile input state with it.
    pub(crate) fn set_tree(&mut self, tree: NodeSpec, cx: &mut App) {
        self.tree = Rc::new(tree);
        self.sync_inputs(cx);
        self.sync_key_targets(cx);
        crate::list::sync(&mut self.lists, &self.tree);
        self.heights.sync(&self.tree);
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
                    if state.revision != spec.revision {
                        state.revision = spec.revision;
                        state.buffer = spec.value.clone();
                        state.cursor = state.buffer.chars().count();
                        state.synced_value = spec.value.clone();
                        state.echoes.clear();
                    } else if state.synced_value != spec.value {
                        if driver_resets(&mut state.echoes, &spec.value) {
                            state.buffer = spec.value.clone();
                            state.cursor = state.buffer.chars().count();
                        }
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
                            echoes: VecDeque::new(),
                            revision: spec.revision,
                            wants_focus: spec.autofocus,
                            select_all: false,
                        },
                    );
                }
            }
        }
        self.inputs.retain(|id, _| seen.contains(id));
    }

    /// Focus handles for new `onKeyDown` views (each takes the keyboard once,
    /// when it appears); drop the ones that left the tree.
    fn sync_key_targets(&mut self, cx: &mut App) {
        let mut ids = Vec::new();
        collect_key_ids(&self.tree, &mut ids);
        for id in &ids {
            self.key_targets
                .entry(id.clone())
                .or_insert_with(|| KeyTarget {
                    focus: cx.focus_handle(),
                    wants_focus: true,
                });
        }
        self.key_targets.retain(|id, _| ids.contains(id));
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
    pub(crate) fn apply_pending_focus(&mut self, window: &mut Window) {
        for target in self.key_targets.values_mut() {
            if target.wants_focus {
                target.wants_focus = false;
                window.focus(&target.focus);
            }
        }
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
        if self.drop_target.is_some() && !cx.has_active_drag() {
            self.files_gone(window);
        }
        let tree = self.tree.clone();
        let content = render_node(&tree, self, window, cx);
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;
        let root = capture_root(content, cx);
        let first = std::mem::take(&mut self.first_frame);
        if !first && !crate::trace::enabled() {
            return root;
        }
        // Painted last, so its paint callback marks the end of GPUI's layout,
        // prepaint, and paint for this frame: the trace's timing, and a new
        // window's first frame (`{"type":"frame"}`, for a driver timing an open).
        let size = window.viewport_size();
        let events = self.events.clone();
        let marker = gpui::canvas(
            |_, _, _| {},
            move |_, (), _, _| {
                if first {
                    events.frame();
                }
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

#[cfg(test)]
mod tests {
    use super::driver_resets;
    use std::collections::VecDeque;

    fn sent(values: &[&str]) -> VecDeque<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn late_echoes_never_reset_the_buffer() {
        // Typed "abc" faster than the driver answers; its "a" arrives last.
        let mut echoes = sent(&["a", "ab", "abc"]);
        assert!(!driver_resets(&mut echoes, "a"));
        assert_eq!(echoes, sent(&["ab", "abc"]));
        // A driver that batches may skip straight to the newest.
        assert!(!driver_resets(&mut echoes, "abc"));
        assert!(echoes.is_empty());
    }

    #[test]
    fn a_new_value_from_the_driver_wins() {
        let mut echoes = sent(&["pass"]);
        assert!(driver_resets(&mut echoes, ""));
        assert!(echoes.is_empty());
        assert!(driver_resets(&mut echoes, "ABC"));
    }
}
