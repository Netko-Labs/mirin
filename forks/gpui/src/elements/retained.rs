//! mirin: a subtree kept across frames.
//!
//! GPUI builds, lays out, prepaints and paints the whole element tree every
//! frame. A [`Retained`] subtree is built only when its content changed: the
//! caller names it with a stable id, a view id and a content `version`, and
//! while the version is the same and nothing inside it was notified, the
//! subtree is not built again. Its taffy nodes stay in the tree (with their
//! layout cache, so taffy skips the subtree unless its constraints changed),
//! and when it lands where it was last drawn (same bounds, content mask and
//! text style) last frame's hitboxes, dispatch nodes, listeners and scene
//! primitives are copied instead of drawn. When it lands elsewhere it is
//! built and drawn again, laid out apart as its kept nodes are laid out
//! where they sit (`TaffyLayoutEngine::compute_detached_layout`).
//!
//! Its elements' states live in its own state (`ElementStateScope`), not
//! the frame's, so a reused subtree carries them all as one.
//!
//! Unlike `AnyView::cached`, a retained subtree may size itself from its
//! content, and retained subtrees nest: a subtree that is reused carries the
//! ones inside it, and one that is built again reuses the clean ones inside
//! it. Every range a subtree keeps into last frame's lists is moved along
//! when the subtree around it is copied, so it stays valid however many
//! frames it is not visited.
//!
//! What it renders must depend only on its content (the version) and on
//! state whose changes notify the view (`cx.notify(view)`, which GPUI's hover
//! styles and image loads do through `window.current_view()`): a refresh of
//! the whole window (`window.refresh()`) does not rebuild it.

use std::{cell::RefCell, mem, ops::Range, rc::Rc};

use collections::FxHashMap;

use crate::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, EntityId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, PaintIndex, Pixels, PrepaintStateIndex, TextStyle,
    Window, window::ElementStateBox, window::ElementStateScope,
};

type Build = Box<dyn FnOnce(&mut Window, &mut App) -> AnyElement>;
type OnPrepaint = Box<dyn FnOnce(bool, &mut Window, &mut App)>;
type States = FxHashMap<(GlobalElementId, std::any::TypeId), ElementStateBox>;

/// A subtree built only when its content changed. See the module docs.
pub struct Retained {
    id: ElementId,
    view: EntityId,
    version: u64,
    build: Option<Build>,
    on_prepaint: Option<OnPrepaint>,
}

/// A subtree kept across frames (see [`Retained`]): `build` makes its
/// element and runs only when `version` changed, `view` was notified, or the
/// subtree must be drawn anew. `id` must be stable; `view` names it to
/// notifications (an entity the caller keeps, one per subtree).
pub fn retained(
    id: impl Into<ElementId>,
    view: EntityId,
    version: u64,
    build: impl FnOnce(&mut Window, &mut App) -> AnyElement + 'static,
) -> Retained {
    Retained {
        id: id.into(),
        view,
        version,
        build: Some(Box::new(build)),
        on_prepaint: None,
    }
}

impl Retained {
    /// Called when the subtree is prepainted, with whether last frame's
    /// drawing was reused (nothing inside ran).
    pub fn on_prepaint(
        mut self,
        callback: impl FnOnce(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_prepaint = Some(Box::new(callback));
        self
    }
}

/// Where a subtree's drawing sits in last frame's lists.
#[derive(Clone, Default)]
struct Ranges {
    prepaint: Range<PrepaintStateIndex>,
    paint: Range<PaintIndex>,
}

/// A retained subtree's ranges, shared with the subtrees around it, which
/// move them when they copy their own.
pub(crate) struct RetainedRecord {
    view: EntityId,
    ranges: RefCell<Ranges>,
}

#[derive(PartialEq)]
struct Key {
    bounds: Bounds<Pixels>,
    content_mask: ContentMask<Pixels>,
    text_style: TextStyle,
    scale_factor: f32,
    rem_size: Pixels,
}

struct RetainedState {
    version: u64,
    /// Its taffy subtree's root, kept across frames.
    root: LayoutId,
    /// The taffy nodes it made (not those of the retained subtrees inside).
    owned: Vec<LayoutId>,
    released: Rc<RefCell<Vec<LayoutId>>>,
    /// Where and how it was last drawn.
    key: Option<Key>,
    record: Rc<RetainedRecord>,
    /// Every retained subtree inside, at any depth.
    nested: Vec<Rc<RetainedRecord>>,
    /// Its elements' states as last drawn.
    states: States,
    /// While it is drawn anew this frame: its elements' states, between phases.
    drawing: Option<ElementStateScope>,
    /// A whole frame's drawing is recorded.
    painted: bool,
}

impl Drop for RetainedState {
    fn drop(&mut self) {
        // No longer drawn: its nodes go at the end of the frame.
        self.released.borrow_mut().append(&mut self.owned);
    }
}

#[doc(hidden)]
pub struct RetainedLayout {
    /// Built this frame (its content changed or it was notified).
    element: Option<AnyElement>,
}

#[doc(hidden)]
pub struct RetainedPrepaint {
    /// Drawn this frame; `None` when last frame's drawing was reused.
    element: Option<AnyElement>,
}

impl IntoElement for Retained {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Retained {
    type RequestLayoutState = RetainedLayout;
    type PrepaintState = RetainedPrepaint;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let global_id = global_id.expect("a retained subtree has an id");
        let text_style = window.text_style();
        let scale_factor = window.scale_factor();
        let rem_size = window.rem_size();
        let detached = window.retained_detached > 0;
        let dirty = window.dirty_views.contains(&self.view);
        let (view, version) = (self.view, self.version);
        let build = self.build.take();
        let (layout_id, element, build) =
            window.with_element_state::<RetainedState, _>(global_id, |state, window| {
                let reusable = state.as_ref().is_some_and(|state| {
                    !detached
                        && !dirty
                        && state.painted
                        && state.version == version
                        && state.key.as_ref().is_some_and(|key| {
                            key.text_style == text_style
                                && key.scale_factor == scale_factor
                                && key.rem_size == rem_size
                        })
                        && window.layout_engine().contains(state.root)
                });
                match state {
                    // Clean: its kept nodes go into this frame's tree as they are.
                    Some(state) if reusable => ((state.root, None, build), state),
                    state => {
                        let build = build.expect("a retained subtree is built once a frame");
                        let (root, element, state) =
                            build_layout(state, view, version, build, detached, window, cx);
                        ((root, Some(element), None), state)
                    }
                }
            });
        self.build = build;
        (layout_id, RetainedLayout { element })
    }

    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let global_id = global_id.expect("a retained subtree has an id");
        window.set_view_id(self.view);
        let key = Key {
            bounds,
            content_mask: window.content_mask(),
            text_style: window.text_style(),
            scale_factor: window.scale_factor(),
            rem_size: window.rem_size(),
        };
        let view = self.view;
        let built = layout.element.take();
        let build = self.build.take();
        let (element, reused) =
            window.with_element_state::<RetainedState, _>(global_id, |state, window| {
                let mut state =
                    state.expect("a retained subtree is laid out before it is prepainted");
                let reusable = built.is_none() && state.key.as_ref() == Some(&key) && {
                    let ranges = state.record.ranges.borrow();
                    window.prepaint_range_valid(&ranges.prepaint)
                        && window.paint_range_valid(&ranges.paint)
                };
                let element = if reusable {
                    // Where it was: copy last frame's drawing.
                    let old = state.record.ranges.borrow().prepaint.clone();
                    let start = window.prepaint_index();
                    window.reuse_prepaint(old.clone());
                    for record in &state.nested {
                        let mut ranges = record.ranges.borrow_mut();
                        ranges.prepaint = moved_prepaint(&ranges.prepaint, &old, &start);
                    }
                    state.record.ranges.borrow_mut().prepaint = start..window.prepaint_index();
                    let mut accessed = cx.entities.accessed_entities.borrow_mut();
                    accessed.extend(state.nested.iter().map(|record| record.view));
                    None
                } else {
                    let start = window.prepaint_index();
                    window.retained_collectors.push(Vec::new());
                    let element = match built {
                        // Built this frame: draw it.
                        Some(mut element) => {
                            let scope = state.drawing.take().unwrap_or_default();
                            window.element_state_scopes.push(scope);
                            window.with_rendered_view(view, |window| element.prepaint(window, cx));
                            state.drawing = window.element_state_scopes.pop();
                            element
                        }
                        // Its layout is kept but it landed elsewhere (or its
                        // last drawing is gone): build it again and draw it
                        // from a detached copy laid out as its kept nodes are.
                        None => {
                            let build = build.expect("a retained subtree is built once a frame");
                            let mut element = build(window, cx);
                            window.element_state_scopes.push(ElementStateScope {
                                prev: mem::take(&mut state.states),
                                next: States::default(),
                            });
                            window.retained_detached += 1;
                            let copy = window.with_rendered_view(view, |window| {
                                element.request_layout(window, cx)
                            });
                            window.compute_detached_layout(copy, state.root, cx);
                            let placed = window.layout_bounds(copy);
                            window.with_element_offset(bounds.origin - placed.origin, |window| {
                                window
                                    .with_rendered_view(view, |window| element.prepaint(window, cx))
                            });
                            window.retained_detached -= 1;
                            state.drawing = window.element_state_scopes.pop();
                            element
                        }
                    };
                    state.nested = window.retained_collectors.pop().unwrap_or_default();
                    state.record.ranges.borrow_mut().prepaint = start..window.prepaint_index();
                    Some(element)
                };
                let reused = element.is_none();
                state.key = Some(key);
                cx.entities.accessed_entities.borrow_mut().insert(view);
                if let Some(parent) = window.retained_collectors.last_mut() {
                    parent.push(state.record.clone());
                    parent.extend(state.nested.iter().cloned());
                }
                ((element, reused), state)
            });
        if let Some(on_prepaint) = self.on_prepaint.take() {
            on_prepaint(reused, window, cx);
        }
        RetainedPrepaint { element }
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let global_id = global_id.expect("a retained subtree has an id");
        let view = self.view;
        window.with_element_state::<RetainedState, _>(global_id, |state, window| {
            let mut state = state.expect("a retained subtree is prepainted before it is painted");
            let start = window.paint_index();
            match prepaint.element.as_mut() {
                Some(element) => {
                    let scope = state.drawing.take().unwrap_or_default();
                    window.element_state_scopes.push(scope);
                    window.with_rendered_view(view, |window| element.paint(window, cx));
                    if let Some(scope) = window.element_state_scopes.pop() {
                        // What it no longer has goes (`scope.prev`, dropped).
                        state.states = scope.next;
                    }
                }
                None => {
                    let old = state.record.ranges.borrow().paint.clone();
                    window.reuse_paint(old.clone());
                    for record in &state.nested {
                        let mut ranges = record.ranges.borrow_mut();
                        ranges.paint = moved_paint(&ranges.paint, &old, &start);
                    }
                }
            }
            state.record.ranges.borrow_mut().paint = start..window.paint_index();
            state.painted = true;
            ((), state)
        });
    }
}

impl RetainedState {
    fn new(
        view: EntityId,
        version: u64,
        root: LayoutId,
        owned: Vec<LayoutId>,
        window: &mut Window,
    ) -> Self {
        Self {
            version,
            root,
            owned,
            released: window.layout_engine().released(),
            key: None,
            record: Rc::new(RetainedRecord {
                view,
                ranges: RefCell::new(Ranges::default()),
            }),
            nested: Vec::new(),
            states: States::default(),
            drawing: None,
            painted: false,
        }
    }
}

/// Build a retained subtree's element and lay it out: its own nodes, kept
/// for later frames, or (inside a subtree drawn apart, `detached`) this
/// frame's only, leaving the nodes it keeps as they are.
fn build_layout(
    state: Option<RetainedState>,
    view: EntityId,
    version: u64,
    build: Build,
    detached: bool,
    window: &mut Window,
    cx: &mut App,
) -> (LayoutId, AnyElement, RetainedState) {
    let mut element = build(window, cx);
    let mut state = state;
    let prev = state
        .as_mut()
        .map(|state| mem::take(&mut state.states))
        .unwrap_or_default();
    window.element_state_scopes.push(ElementStateScope {
        prev,
        next: States::default(),
    });
    let (root, owned) = if detached {
        let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        (root, None)
    } else {
        if let Some(state) = &mut state {
            // Its old nodes go before the new ones adopt the clean subtrees inside.
            let owned = mem::take(&mut state.owned);
            window.layout_engine().remove_nodes(owned);
        }
        window.layout_engine().begin_owned();
        let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        (root, Some(window.layout_engine().end_owned()))
    };
    let drawing = window.element_state_scopes.pop();
    let mut state = match (state, owned) {
        (Some(mut state), Some(owned)) => {
            state.version = version;
            state.root = root;
            state.owned = owned;
            state.key = None;
            state.painted = false;
            state
        }
        (Some(mut state), None) => {
            if state.version != version {
                // Not expected (the subtree around it is clean); build it
                // properly next frame.
                state.painted = false;
            }
            state
        }
        // A detached first build keeps no nodes; the next frame builds it properly.
        (None, owned) => RetainedState::new(view, version, root, owned.unwrap_or_default(), window),
    };
    state.drawing = drawing;
    (root, element, state)
}

/// `range` (start and end per list) moved along with the range `from` it
/// lies in, now copied to start at `to`; `None` when it doesn't lie in it.
fn moved<const N: usize>(
    range: ([usize; N], [usize; N]),
    from: ([usize; N], [usize; N]),
    to: [usize; N],
) -> Option<([usize; N], [usize; N])> {
    let mut out = range;
    for index in 0..N {
        let inside = from.0[index] <= range.0[index]
            && range.0[index] <= range.1[index]
            && range.1[index] <= from.1[index];
        if !inside {
            return None;
        }
        out.0[index] = range.0[index] - from.0[index] + to[index];
        out.1[index] = range.1[index] - from.0[index] + to[index];
    }
    Some(out)
}

fn prepaint_fields(index: &PrepaintStateIndex) -> [usize; 7] {
    [
        index.hitboxes_index,
        index.tooltips_index,
        index.deferred_draws_index,
        index.dispatch_tree_index,
        index.accessed_element_states_index,
        index.line_layout_index.lines_index,
        index.line_layout_index.wrapped_lines_index,
    ]
}

fn prepaint_index(fields: [usize; 7]) -> PrepaintStateIndex {
    let mut index = PrepaintStateIndex::default();
    index.hitboxes_index = fields[0];
    index.tooltips_index = fields[1];
    index.deferred_draws_index = fields[2];
    index.dispatch_tree_index = fields[3];
    index.accessed_element_states_index = fields[4];
    index.line_layout_index.lines_index = fields[5];
    index.line_layout_index.wrapped_lines_index = fields[6];
    index
}

/// A nested subtree's prepaint range moved with the one around it (made
/// invalid, so it is drawn anew, if it doesn't lie in it).
fn moved_prepaint(
    range: &Range<PrepaintStateIndex>,
    from: &Range<PrepaintStateIndex>,
    to: &PrepaintStateIndex,
) -> Range<PrepaintStateIndex> {
    match moved(
        (prepaint_fields(&range.start), prepaint_fields(&range.end)),
        (prepaint_fields(&from.start), prepaint_fields(&from.end)),
        prepaint_fields(to),
    ) {
        Some((start, end)) => prepaint_index(start)..prepaint_index(end),
        None => prepaint_index([usize::MAX; 7])..PrepaintStateIndex::default(),
    }
}

fn paint_fields(index: &PaintIndex) -> [usize; 8] {
    [
        index.scene_index,
        index.mouse_listeners_index,
        index.input_handlers_index,
        index.cursor_styles_index,
        index.accessed_element_states_index,
        index.tab_handle_index,
        index.line_layout_index.lines_index,
        index.line_layout_index.wrapped_lines_index,
    ]
}

fn paint_index(fields: [usize; 8]) -> PaintIndex {
    let mut index = PaintIndex::default();
    index.scene_index = fields[0];
    index.mouse_listeners_index = fields[1];
    index.input_handlers_index = fields[2];
    index.cursor_styles_index = fields[3];
    index.accessed_element_states_index = fields[4];
    index.tab_handle_index = fields[5];
    index.line_layout_index.lines_index = fields[6];
    index.line_layout_index.wrapped_lines_index = fields[7];
    index
}

/// A nested subtree's paint range moved with the one around it.
fn moved_paint(
    range: &Range<PaintIndex>,
    from: &Range<PaintIndex>,
    to: &PaintIndex,
) -> Range<PaintIndex> {
    match moved(
        (paint_fields(&range.start), paint_fields(&range.end)),
        (paint_fields(&from.start), paint_fields(&from.end)),
        paint_fields(to),
    ) {
        Some((start, end)) => paint_index(start)..paint_index(end),
        None => paint_index([usize::MAX; 8])..PaintIndex::default(),
    }
}

#[cfg(test)]
mod tests;
