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

use crate::{
    AnyElement, App, Bounds, ContentMask, Element, ElementId, EntityId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, PaintIndex, Pixels, PrepaintStateIndex, TextStyle,
    Window,
};

type Build = Box<dyn FnOnce(&mut Window, &mut App) -> AnyElement>;
type OnPrepaint = Box<dyn FnOnce(bool, &mut Window, &mut App)>;

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
    /// Element states accessed while it was laid out.
    layout_states: Range<usize>,
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
    /// A whole frame's drawing is recorded.
    painted: bool,
    /// Built this frame inside a subtree drawn apart: where its prepaint
    /// range starts (before it was laid out, so the element states it
    /// accessed then count as prepainted).
    detached_start: Option<PrepaintStateIndex>,
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
                        && window
                            .element_states_range_valid(&state.record.ranges.borrow().layout_states)
                });
                let state = match state {
                    Some(state) if reusable => state,
                    state => {
                        let build = build.expect("a retained subtree is built once a frame");
                        let (root, element, state) =
                            build_layout(state, view, version, build, detached, window, cx);
                        return ((root, Some(element), None), state);
                    }
                };
                // Clean: its kept nodes go into this frame's tree as they are.
                let old = state.record.ranges.borrow().layout_states.clone();
                let start = window.element_states_index();
                window.reuse_element_states(old.clone());
                for record in &state.nested {
                    let mut ranges = record.ranges.borrow_mut();
                    ranges.layout_states = moved_states(&ranges.layout_states, &old, start, true);
                }
                state.record.ranges.borrow_mut().layout_states =
                    start..window.element_states_index();
                ((state.root, None, build), state)
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
                let (element, reused) = if let Some(mut element) = built {
                    // Built this frame: draw it.
                    let start = state
                        .detached_start
                        .take()
                        .unwrap_or_else(|| window.prepaint_index());
                    window.retained_collectors.push(Vec::new());
                    window.with_rendered_view(view, |window| element.prepaint(window, cx));
                    state.nested = window.retained_collectors.pop().unwrap_or_default();
                    state.record.ranges.borrow_mut().prepaint = start..window.prepaint_index();
                    (Some(element), false)
                } else if state.key.as_ref() == Some(&key) && {
                    let ranges = state.record.ranges.borrow();
                    window.prepaint_range_valid(&ranges.prepaint)
                        && window.paint_range_valid(&ranges.paint)
                } {
                    // Where it was: copy last frame's drawing.
                    let old = state.record.ranges.borrow().prepaint.clone();
                    let start = window.prepaint_index();
                    window.reuse_prepaint(old.clone());
                    let old_states = old.start.accessed_element_states_index
                        ..old.end.accessed_element_states_index;
                    for record in &state.nested {
                        let mut ranges = record.ranges.borrow_mut();
                        ranges.prepaint = moved_prepaint(&ranges.prepaint, &old, &start);
                        ranges.layout_states = moved_states(
                            &ranges.layout_states,
                            &old_states,
                            start.accessed_element_states_index,
                            false,
                        );
                    }
                    state.record.ranges.borrow_mut().prepaint = start..window.prepaint_index();
                    let mut accessed = cx.entities.accessed_entities.borrow_mut();
                    accessed.extend(state.nested.iter().map(|record| record.view));
                    (None, true)
                } else {
                    // Its layout is kept but it landed elsewhere (or its last
                    // drawing is gone): build it again and draw it from a
                    // detached copy laid out as the kept nodes are.
                    let mut element =
                        (build.expect("a retained subtree is built once a frame"))(window, cx);
                    let start = window.prepaint_index();
                    window.retained_collectors.push(Vec::new());
                    window.retained_detached += 1;
                    let copy = window
                        .with_rendered_view(view, |window| element.request_layout(window, cx));
                    window.compute_detached_layout(copy, state.root, cx);
                    let placed = window.layout_bounds(copy);
                    window.with_element_offset(bounds.origin - placed.origin, |window| {
                        window.with_rendered_view(view, |window| element.prepaint(window, cx))
                    });
                    window.retained_detached -= 1;
                    state.nested = window.retained_collectors.pop().unwrap_or_default();
                    let mut ranges = state.record.ranges.borrow_mut();
                    ranges.layout_states =
                        start.accessed_element_states_index..start.accessed_element_states_index;
                    ranges.prepaint = start..window.prepaint_index();
                    drop(ranges);
                    (Some(element), false)
                };
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
                    window.with_rendered_view(view, |window| element.paint(window, cx));
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
            painted: false,
            detached_start: None,
        }
    }
}

/// Build a retained subtree's element and lay it out: its own nodes, kept
/// for later frames, or (inside a subtree drawn apart, `detached`) this
/// frame's only, leaving what it keeps as it is.
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
    let start = window.element_states_index();
    if detached {
        // What it accesses counts as prepainted (its prepaint range starts
        // here), so its layout range is empty.
        let prepaint_start = window.prepaint_index();
        let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        let mut state = match state {
            Some(mut state) => {
                if state.version != version {
                    // Not expected (the subtree around it is clean); build it
                    // properly next frame.
                    state.painted = false;
                }
                state
            }
            None => RetainedState::new(view, version, root, Vec::new(), window),
        };
        state.record.ranges.borrow_mut().layout_states = start..start;
        state.detached_start = Some(prepaint_start);
        return (root, element, state);
    }

    let mut state = state;
    if let Some(state) = &mut state {
        // Its old nodes go before the new ones adopt the clean subtrees inside.
        let owned = mem::take(&mut state.owned);
        window.layout_engine().remove_nodes(owned);
    }
    window.layout_engine().begin_owned();
    let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
    let owned = window.layout_engine().end_owned();
    let layout_states = start..window.element_states_index();
    let state = match state {
        Some(mut state) => {
            state.version = version;
            state.root = root;
            state.owned = owned;
            state.key = None;
            state.painted = false;
            state
        }
        None => RetainedState::new(view, version, root, owned, window),
    };
    state.record.ranges.borrow_mut().layout_states = layout_states;
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

/// A nested subtree's layout-time element states, moved with `from` when
/// they lie in it. Copying the range around them as it was laid out
/// (`strict`), they must lie in it: one that doesn't is made invalid, so the
/// subtree is built again. Copying its prepaint range, only ranges recorded
/// while drawn detached (which are empty) lie in it, and others stay. An
/// empty range copies nothing; it is kept within the list.
fn moved_states(
    range: &Range<usize>,
    from: &Range<usize>,
    to: usize,
    strict: bool,
) -> Range<usize> {
    match moved(
        ([range.start], [range.end]),
        ([from.start], [from.end]),
        [to],
    ) {
        Some(([start], [end])) => start..end,
        None if range.start == range.end => to..to,
        None if strict => usize::MAX..0,
        None => range.clone(),
    }
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
mod tests {
    use super::moved_states;

    #[test]
    fn a_nested_range_moves_with_the_range_it_lies_in() {
        assert_eq!(moved_states(&(12..15), &(10..20), 40, true), 42..45);
        assert_eq!(moved_states(&(10..20), &(10..20), 0, true), 0..20);
        assert_eq!(moved_states(&(12..15), &(10..20), 40, false), 42..45);
    }

    #[test]
    fn a_nested_range_outside_the_layout_copy_is_made_invalid() {
        let out = moved_states(&(5..8), &(10..20), 40, true);
        assert!(out.start > out.end);
        // Empty ranges copy nothing; they stay within the list.
        assert_eq!(moved_states(&(3..3), &(10..20), 40, true), 40..40);
    }

    #[test]
    fn a_layout_range_outside_a_prepaint_copy_stays() {
        // Moved with the layout copy already; the prepaint copy leaves it.
        assert_eq!(moved_states(&(5..8), &(10..20), 40, false), 5..8);
    }
}
