//! Window shell: open a GPU-rendered GPUI window that renders a driver-owned
//! element tree, applies streamed tree updates, keeps the editing state of
//! `input` nodes, and reports interaction events.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use std::cell::RefCell;

use gpui::{prelude::*, App, Context, FocusHandle, ScrollHandle, SharedString, Window};

use crate::access::{Accessibility, Focused};
use crate::events::EventSender;
use crate::field::Field;
use crate::height::Heights;
use crate::ime::CaretReported;
use crate::list::VirtualList;
use crate::patch::{Applied, Document, PatchError, PatchOp, Touched};
use crate::pointer::capture_root;
use crate::render::{record_root_bounds, render_node};
use crate::selection::SelectionState;
use crate::sim::{LayoutMap, SimCommand};
use crate::surface::Surface;
use crate::titlebar::TitleBar;
use crate::tree::{collect_inputs, collect_key_ids, collect_scroll_ids, NodeSpec};

/// Unechoed `change` values kept per input (see `InputState::echoes`).
const MAX_ECHOES: usize = 64;

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
    /// A close from outside (the compositor's close control, a shell's
    /// close or quit: `xdg_toplevel.close`) is not carried out but reported
    /// as `close-request` (`MIRIN_METAL_CLOSE=ask`): the driver answers by
    /// ending the host, or keeps the window and asks first. Windows only.
    pub ask_to_close: bool,
    /// The smallest size the person can make the window
    /// (`MIRIN_METAL_MIN_SIZE`, `xdg_toplevel.set_min_size`): an app whose
    /// layout stops working below it. None leaves it to the compositor.
    /// Windows only.
    pub min_size: Option<(f32, f32)>,
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
            ask_to_close: false,
            min_size: None,
        }
    }
}

/// What a driver sends to the window.
#[derive(Debug, Clone, PartialEq)]
pub enum DriverMessage {
    /// Replace the rendered tree (last write wins per tick).
    Tree(Box<NodeSpec>),
    /// Change the tree in place (`patch/`); patches apply in order, after
    /// the newest whole tree of the tick.
    Patch(Vec<PatchOp>),
    /// Simulate input or query layout (`sim.rs`).
    Sim(SimCommand),
    /// Unlock the session this lock surface locked, then quit
    /// (`{"unlock": true}`; the only way a lock surface unlocks).
    Unlock,
    /// Retitle the window (`{"title": "..."}`): what the compositor's title
    /// bar, the window switcher, and the taskbar show.
    Title(String),
    /// Resize the window (`{"size": {"width": W, "height": H}}`, logical
    /// px): an app growing to show a sidebar. The compositor may still
    /// decide otherwise (a zoomed or tiled window keeps its size).
    Size(f32, f32),
    /// Change the smallest the window may be made (`{"minSize": {"width":
    /// W, "height": H}}`, logical px; `MIRIN_METAL_MIN_SIZE` is the first):
    /// an app that needs more room while it shows more (a sidebar). It does
    /// not resize the window; send a size too.
    MinSize(f32, f32),
}

/// Whether a new driver `value` resets the buffer. A value the renderer sent
/// itself (a late echo, possibly skipping older ones) does not; anything else
/// does, and forgets the pending echoes.
pub(crate) fn driver_resets<T, V>(echoes: &mut VecDeque<T>, value: &V) -> bool
where
    T: PartialEq<V>,
    V: ?Sized,
{
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
    /// Its text, caret, select-all, and an input method's composition.
    pub(crate) field: Field,
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
    /// Where the caret was last told to an input method (`ime.rs`).
    pub(crate) caret_reported: CaretReported,
    /// The selection: as drawn, being made with the pointer, and as the driver has it.
    pub(crate) selection: SelectionState,
    /// How far a one-line text is drawn shifted to keep the caret in view (`follow.rs`).
    pub(crate) scroll: Rc<std::cell::Cell<f32>>,
}

/// The root view: renders whatever tree the driver last sent.
pub(crate) struct RootView {
    /// The driver's tree, replaced whole or patched in place (`patch/`),
    /// with the generation each node last changed in. A frame shares it
    /// (`Document::tree`) only while it walks it.
    pub(crate) tree: Document,
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
    /// The views the current presses belong to: the innermost with the
    /// handler (`press.rs`).
    pub(crate) claims: crate::press::Claims,
    /// Scroll state of scrollable nodes, by id, for programmatic scrolling.
    pub(crate) scrolls: HashMap<String, ScrollHandle>,
    /// When each scrollable node last scrolled, for its auto-hiding scroll bar (`scrollbar.rs`).
    pub(crate) scroll_activity: HashMap<String, crate::scrollbar::Activity>,
    /// Set while rendering a child of a view that scrolls along its
    /// direction: the child keeps its length there (render.rs).
    pub(crate) keeps_length: bool,
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
    /// The tree shown is the host's placeholder, not one the driver sent.
    placeholder: bool,
    /// A driver's tree has been painted (traced once: an open's time to content).
    content_painted: bool,
    /// The accessibility tree, published after each paint (`access/`); none when turned off.
    pub(crate) access: Option<Rc<RefCell<Accessibility>>>,
    /// Which field or view the keyboard goes to with Tab and the arrows (`focus/`).
    pub(crate) focus: crate::focus::FocusState,
    /// The subtrees GPUI keeps across frames (`retain.rs`).
    pub(crate) boundaries: crate::retain::Boundaries,
    /// While a retained subtree is built: its group (`sim::LayoutMap`).
    pub(crate) group: Option<u64>,
}

/// A view with `onKeyDown`: its focus, and whether it still has to take it.
pub(crate) struct KeyTarget {
    pub(crate) focus: FocusHandle,
    pub(crate) wants_focus: bool,
}

impl RootView {
    /// A view showing `tree`; `placeholder` when it is the host's stand-in
    /// rather than the driver's.
    pub(crate) fn new(
        tree: Document,
        placeholder: bool,
        events: EventSender,
        layout: LayoutMap,
        cx: &mut App,
    ) -> Self {
        let mut view = Self {
            tree,
            events,
            inputs: HashMap::new(),
            layout,
            dragging: None,
            press_claimed: false,
            claims: crate::press::Claims::default(),
            scrolls: HashMap::new(),
            scroll_activity: HashMap::new(),
            keeps_length: false,
            lists: HashMap::new(),
            key_targets: HashMap::new(),
            drag_candidate: None,
            drop_target: None,
            heights: Heights::default(),
            first_frame: true,
            placeholder,
            content_painted: false,
            access: None,
            focus: crate::focus::FocusState::new(cx),
            boundaries: crate::retain::Boundaries::default(),
            group: None,
        };
        view.boundaries.sync(None, &view.tree, false, cx);
        view.focus.sync(&view.tree, cx);
        view.sync_inputs(cx);
        view.sync_key_targets(cx);
        crate::list::sync(&mut view.lists, &view.tree);
        view.heights.sync(&view.tree);
        view
    }

    /// Replace the tree and reconcile input state with it.
    pub(crate) fn set_tree(&mut self, tree: NodeSpec, cx: &mut App) {
        // A whole tree: retained subtrees are compared with the old one (retain.rs).
        let old = Rc::clone(self.tree.tree());
        self.tree.replace(tree);
        self.boundaries.sync(Some(&old), &self.tree, false, cx);
        drop(old);
        self.placeholder = false;
        self.tree_changed(&Applied::everything(), cx);
    }

    /// Change the tree in place (`patch/`) and reconcile input state with
    /// it. On an error the tree is as far as the patch got; the driver is
    /// to send it whole.
    pub(crate) fn apply_patch(
        &mut self,
        ops: Vec<PatchOp>,
        cx: &mut App,
    ) -> Result<(), PatchError> {
        let applied = self.tree.apply(ops);
        // A patch: the generations say which retained subtrees changed (retain.rs).
        self.boundaries.sync(None, &self.tree, applied.is_ok(), cx);
        self.placeholder = false;
        match &applied {
            Ok(applied) => self.tree_changed(applied, cx),
            Err(_) => self.tree_changed(&Applied::everything(), cx),
        }
        applied.map(|_| ())
    }

    /// Bring the renderer's own state (focus, fields, key views, lists,
    /// heights, scroll views) in line with the tree as it now is: the parts
    /// a change may concern (`touched`), each a walk of the whole tree, and
    /// the fields whose props changed.
    fn tree_changed(&mut self, applied: &Applied, cx: &mut App) {
        let touched = applied.touched;
        if touched.contains(Touched::FOCUS) {
            self.focus.sync(&self.tree, cx);
        }
        if touched.contains(Touched::INPUTS) {
            self.sync_inputs(cx);
        } else {
            for id in &applied.fields {
                if let Some(NodeSpec::Input { props }) = self.tree.find(id) {
                    sync_input(&mut self.inputs, &self.events, props, cx);
                }
            }
        }
        if touched.contains(Touched::KEYS) {
            self.sync_key_targets(cx);
        }
        // A list's rows are copies: a change inside them (its generation) needs them again.
        let generation = self.tree.generation();
        if touched.contains(Touched::LISTS)
            || self
                .lists
                .keys()
                .any(|id| self.tree.subtree_generation(id) == generation)
        {
            crate::list::sync(&mut self.lists, &self.tree);
        }
        if touched.contains(Touched::HEIGHTS) {
            self.heights.sync(&self.tree);
        }
        if touched.contains(Touched::SCROLLS) {
            let mut ids = HashSet::new();
            collect_scroll_ids(&self.tree, &mut ids);
            self.scrolls.retain(|id, _| ids.contains(id));
            self.scroll_activity.retain(|id, _| ids.contains(id));
        }
    }

    /// Create state for new inputs, reset buffers whose driver value changed,
    /// and drop state for inputs that left the tree.
    fn sync_inputs(&mut self, cx: &mut App) {
        let mut specs = Vec::new();
        collect_inputs(&self.tree, &mut specs);
        let mut seen = Vec::with_capacity(specs.len());
        for spec in specs {
            seen.push(spec.id.clone());
            sync_input(&mut self.inputs, &self.events, spec, cx);
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

    /// Tell the driver a field's text changed (`change`), and expect it back.
    pub(crate) fn report_change(&mut self, id: &str) {
        let Some(state) = self.inputs.get_mut(id) else {
            return;
        };
        self.events.change(id, &state.field.buffer);
        // Expect it back; a driver that never echoes (or transforms the
        // text) only ever keeps a few.
        if state.echoes.len() >= MAX_ECHOES {
            state.echoes.pop_front();
        }
        state.echoes.push_back(state.field.buffer.clone());
    }

    /// Move focus from the field `from` to the next (`+1`) or previous
    /// (`-1`) field or focusable view in the Tab order (`focus/`), wrapping
    /// around. Tab / Shift+Tab.
    pub(crate) fn focus_neighbor(&mut self, from: &str, step: isize, window: &mut Window) {
        self.tab_from(Some(from), step < 0, window);
    }

    /// The field or key-taking view with the keyboard, and what is typed in a field.
    fn focused(&self, window: &Window) -> Option<Focused> {
        let field = self
            .inputs
            .iter()
            .find(|(_, state)| state.focus.is_focused(window));
        if let Some((id, state)) = field {
            return Some(Focused {
                id: id.clone(),
                text: Some(state.field.buffer.clone()),
            });
        }
        self.key_targets
            .iter()
            .find(|(_, target)| target.focus.is_focused(window))
            .map(|(id, _)| id.as_str())
            .or_else(|| self.focus.focused_view(window))
            .map(|id| Focused {
                id: id.to_owned(),
                text: None,
            })
    }

    /// Painted last, after everything else: publishes the accessibility tree
    /// with this frame's bounds (`access/`).
    fn access_canvas(&self, window: &Window) -> Option<gpui::AnyElement> {
        let access = Rc::clone(self.access.as_ref()?);
        // Weak: a patch after this frame must find the tree unshared, or it
        // copies it whole.
        let tree = Rc::downgrade(self.tree.tree());
        let generation = self.tree.generation();
        let layout = self.layout.clone();
        let focused = self.focused(window);
        let active = window.is_window_active();
        Some(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), _, _| {
                    let Some(tree) = tree.upgrade() else {
                        return;
                    };
                    access.borrow_mut().refresh(
                        &tree,
                        generation,
                        &layout,
                        focused.clone(),
                        active,
                    );
                },
            )
            .absolute()
            .size_0()
            .into_any_element(),
        )
    }

    /// Honour pending `autofocus` requests. Runs outside of rendering.
    pub(crate) fn apply_pending_focus(&mut self, window: &mut Window) {
        self.focus_window_if_asked(window);
        for target in self.key_targets.values_mut() {
            if target.wants_focus {
                target.wants_focus = false;
                window.focus(&target.focus);
            }
        }
        // Several new fields asking at once: one wins, the same one every time (focus/order.rs).
        let asking: Vec<&str> = self
            .inputs
            .iter()
            .filter(|(_, state)| state.wants_focus)
            .map(|(id, _)| id.as_str())
            .collect();
        let chosen = self.focus.order.autofocus(&asking).map(str::to_owned);
        for state in self.inputs.values_mut() {
            state.wants_focus = false;
        }
        if let Some(state) = chosen.and_then(|id| self.inputs.get(&id)) {
            window.focus(&state.focus);
        }
        self.settle_focus(window);
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
        let tree = Rc::clone(self.tree.tree());
        let content = render_node(&tree, self, window, cx);
        record_root_bounds(&self.layout, &self.events, &tree, window.viewport_size());
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;
        let root = crate::focus::key_root(capture_root(content, cx), self, cx);
        self.report_typing(window);
        let first = std::mem::take(&mut self.first_frame);
        // The first frame with the driver's tree in it: what a person
        // opening the app first sees of it (traced).
        let first_content = !self.placeholder && !self.content_painted;
        self.content_painted |= first_content;
        let access = self.access_canvas(window);
        if !first && !crate::trace::enabled() {
            return match access {
                Some(access) => gpui::div()
                    .size_full()
                    .child(root)
                    .child(access)
                    .into_any_element(),
                None => root,
            };
        }
        // Painted last, so its paint callback marks the end of GPUI's layout,
        // prepaint, and paint for this frame: the trace's timing, and a new
        // window's first frame (`{"type":"frame"}`, for a driver timing an open).
        let size = window.viewport_size();
        let events = self.events.clone();
        let marker = gpui::canvas(
            |_, _, _| {},
            move |_, (), window, _| {
                if first {
                    events.frame();
                }
                if first || first_content {
                    crate::trace::log(format_args!(
                        "first {} frame painted, {:.0}ms after the host started",
                        if first_content {
                            "content"
                        } else {
                            "placeholder"
                        },
                        crate::trace::since_start_ms()
                    ));
                }
                if let Some(dump) = scene_traced() {
                    // For a check that two hosts draw the same (`layout-check --scene`).
                    let digest = window.scene_digest();
                    crate::trace::log(format_args!("scene {digest:016x}"));
                    if let Some(path) = dump {
                        dump_scene(path, digest, &window.scene_drawn());
                    }
                }
                let drawn = crate::retain::take_counts();
                crate::trace::log(format_args!(
                    "render {:.0}x{:.0} took {render_ms:.2}ms, frame {:.2}ms, \
                     retained subtrees {} built, {} redrawn ({} apart), {} reused, {} moved, \
                     {} skipped",
                    f32::from(size.width),
                    f32::from(size.height),
                    started.elapsed().as_secs_f64() * 1000.0,
                    drawn.built,
                    drawn.redrawn,
                    gpui::take_built_apart(),
                    drawn.reused,
                    drawn.moved,
                    drawn.skipped,
                ));
            },
        )
        .absolute()
        .size_0();
        gpui::div()
            .size_full()
            .child(root)
            .child(marker)
            .children(access)
            .into_any_element()
    }
}

/// Whether each frame's trace says what it drew (`MIRIN_METAL_TRACE_SCENE=1`,
/// with `MIRIN_METAL_TRACE=1`): a digest of the scene's primitives and
/// hitboxes, for comparing two hosts. Any other value is a file every
/// frame's primitives and hitboxes are appended to as well (the inner
/// `Some`), for finding what differs.
fn scene_traced() -> Option<Option<&'static std::path::Path>> {
    static TRACED: std::sync::OnceLock<Option<Option<std::path::PathBuf>>> =
        std::sync::OnceLock::new();
    TRACED
        .get_or_init(|| {
            let value = std::env::var("MIRIN_METAL_TRACE_SCENE").ok()?;
            Some((value != "1").then(|| value.into()))
        })
        .as_ref()
        .map(|dump| dump.as_deref())
}

/// Append a frame's drawing to the scene dump (`scene_traced`).
fn dump_scene(path: &std::path::Path, digest: u64, drawn: &[String]) {
    use std::io::Write;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path);
    if let Ok(mut file) = file {
        let _ = writeln!(file, "frame {digest:016x}\n{}", drawn.join("\n"));
    }
}

/// Create the editing state of a field new to the tree, or bring an existing
/// one in line with its props: a new `value` (not an echo) or `revision`
/// resets the buffer, a new `selection` selects.
fn sync_input(
    inputs: &mut HashMap<String, InputState>,
    events: &EventSender,
    spec: &crate::tree::InputProps,
    cx: &mut App,
) {
    match inputs.get_mut(&spec.id) {
        Some(state) => {
            let mut reset = false;
            if state.revision != spec.revision {
                state.revision = spec.revision;
                state.field.reset(&spec.value);
                state.synced_value = spec.value.clone();
                state.echoes.clear();
                reset = true;
            } else if state.synced_value != spec.value {
                if driver_resets(&mut state.echoes, spec.value.as_str()) {
                    state.field.reset(&spec.value);
                    reset = true;
                }
                state.synced_value = spec.value.clone();
            }
            let field = &mut state.field;
            state.selection.sync(field, spec, reset, events);
        }
        None => {
            let mut field = Field::new(&spec.value);
            let selection = SelectionState::new(&mut field, spec);
            inputs.insert(
                spec.id.clone(),
                InputState {
                    focus: cx.focus_handle(),
                    field,
                    synced_value: spec.value.clone(),
                    echoes: VecDeque::new(),
                    revision: spec.revision,
                    wants_focus: spec.autofocus,
                    caret_reported: CaretReported::default(),
                    selection,
                    scroll: Rc::default(),
                },
            );
        }
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
