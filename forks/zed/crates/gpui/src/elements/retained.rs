//! mirin: a subtree kept across frames (`docs/metal/gpui-next.md`, "Retained
//! subtrees on upstream GPUI").
//!
//! GPUI builds, lays out, prepaints and paints the whole element tree every
//! frame. A [`Retained`] subtree is built only when its content changed: the
//! caller names it with a stable id, a view id and a content `version`, and
//! while the version is the same and nothing inside it was notified, the
//! subtree is not built again. Its taffy nodes stay in the layout tree (with
//! taffy's cache, so taffy skips it unless its constraints changed), and each
//! frame it is drawn the cheapest way that gives what drawing it anew would
//! ([`RetainedDraw`]):
//!
//! - where it was, at its size, under the same content mask: last frame's
//!   hitboxes, dispatch nodes, listeners, element states and scene
//!   primitives are copied, as `AnyView::cached` copies a view's;
//! - laid out the same, a whole number of device pixels away (it scrolled,
//!   or what is above it grew), when the caller says it may be
//!   ([`Retained::movable`]): the same are copied, moved, where its last
//!   drawing (`recording`) shows that is what drawing it there gives
//!   (`plan`): what the mask around it hid and the drawing left out stays
//!   hidden (what it hides within 256 px is kept unshown), what it rounds
//!   rounds the same there (`steady`, on the device grid: `grid`), nothing
//!   in it knows where it is, and the pointer was over it neither when it
//!   was drawn nor is now; each primitive, border strip and hitbox is
//!   clipped by its mask (copied, moved, under the one around it there) as
//!   that clips there (`masks`);
//! - where nothing of it shows, when the caller says it may be
//!   ([`Retained::skippable`]) and nothing in it takes keys or focus: not at
//!   all; its drawing is put aside (`parked`, within a budget) and copied
//!   back when it shows again, its element states with it;
//! - otherwise its elements are built again onto the layout nodes it kept
//!   (`TaffyLayoutEngine::begin_bind`: nothing is laid out, and each
//!   measured leaf is asked what it was last asked), so the retained
//!   subtrees inside are each drawn their own cheapest way. When its
//!   elements ask for anything else, or a text was measured again since its
//!   nodes were made, it is built apart from the tree, as the nodes it kept
//!   are laid out (`TaffyLayoutEngine::place_detached`), with the retained
//!   subtrees inside built with it, and made anew the next time it is laid
//!   out.
//!
//! Unlike `AnyView::cached`, a retained subtree may size itself from its
//! content (its nodes are the tree's), and retained subtrees nest: a subtree
//! that is copied carries the ones inside it, and one that is built again
//! copies the clean ones inside it. Every range a subtree keeps into last
//! frame's lists is moved along when a subtree around it is copied, so it is
//! valid in the next frame however it was drawn in this one.
//!
//! What it renders must depend only on its content (the version) and on
//! state whose changes notify the view (`cx.notify(view)`, which GPUI's hover
//! styles do through `window.current_view()`): a refresh of the whole window
//! (`window.refresh()`) does not rebuild it.
//!
//! Its elements' states live in its own state (`ElementStateScope`), not
//! the frame's, so a copied or left-out subtree carries them as one; a
//! copied drawing goes into the bounds tree as one
//! (`Scene::replay_as_one`).
//!
//! A copied drawing's masks are copied with it, moved, under the mask
//! around it where it lands (`masks`, the fork's mask map), so a drawing
//! the view's edge clipped moves; at a scale factor that is not a power of
//! two, positions settle on the device grid (`grid`).
//!
//! Glyphs are placed from their line's grid point (`Window::paint_line_glyph`),
//! so a whole-pixel move keeps every glyph's subpixel variant.
//!
//! Not yet (the fork's `../gpui` has it): where scaling is not exact,
//! moving a drawing with masks pushed inside.

use std::{cell::RefCell, rc::Rc};

use collections::FxHashSet;

use crate::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, Element, ElementId, EntityId,
    GlobalElementId, InspectorElementId, LayoutId, Pixels, Point, TextStyle, Window,
    window::{ElementStateScope, ElementStates},
};

mod grid;
mod masks;
mod parked;
mod plan;
mod recording;
mod steady;

pub(crate) use grid::Grid;
pub(crate) use masks::MaskMap;
pub(crate) use parked::Parking;
pub(crate) use plan::Drawn;
use plan::{Allowed, Place, Plan, plan};
pub(crate) use recording::{Recorded, Recording};
pub(crate) use steady::{Steadiness, is_exact};

type Build = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;
type OnPrepaint = Box<dyn FnOnce(RetainedDraw, Bounds<Pixels>, &mut Window, &mut App)>;

thread_local! {
    static APART: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many retained subtrees were laid out apart since the last call
/// (for a host's trace).
#[doc(hidden)]
pub fn take_built_apart() -> usize {
    APART.with(|apart| apart.replace(0))
}

/// A subtree built only when its content changed. See the module docs.
pub struct Retained {
    id: ElementId,
    view: EntityId,
    version: u64,
    build: Build,
    on_prepaint: Option<OnPrepaint>,
    movable: bool,
    skippable: bool,
    stretchable: bool,
}

/// How a retained subtree was drawn this frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RetainedDraw {
    /// Built (its content changed, or it was notified) and drawn.
    Built,
    /// Its elements were built again and drawn, its layout kept.
    Redrawn,
    /// Last frame's drawing was copied where it was.
    Reused,
    /// Last frame's drawing was copied, moved to where it is now.
    Moved,
    /// Nothing of it shows: it was not drawn.
    Skipped,
}

impl RetainedDraw {
    /// Whether its elements ran this frame (it was not copied or left out).
    pub fn drew(self) -> bool {
        matches!(self, Self::Built | Self::Redrawn)
    }
}

/// A subtree kept across frames (see [`Retained`]): `build` makes its
/// element and runs only when `version` changed, `view` was notified, or the
/// subtree must be drawn anew. `id` must be stable; `view` names it to
/// notifications (an entity the caller keeps, one per subtree).
pub fn retained(
    id: impl Into<ElementId>,
    view: EntityId,
    version: u64,
    build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
) -> Retained {
    Retained {
        id: id.into(),
        view,
        version,
        build: Rc::new(build),
        on_prepaint: None,
        movable: false,
        skippable: false,
        stretchable: false,
    }
}

impl Retained {
    /// Called when the subtree is prepainted, before anything inside it
    /// runs, with how it is drawn this frame and where.
    pub fn on_prepaint(
        mut self,
        callback: impl FnOnce(RetainedDraw, Bounds<Pixels>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_prepaint = Some(Box::new(callback));
        self
    }

    /// Whether its last drawing may be copied to another place when it
    /// moves: nothing inside keeps where it was drawn outside what GPUI
    /// moves along (hitboxes, primitives, content masks). A listener that
    /// reads `Hitbox::bounds` it captured, or state holding window
    /// positions, would be left behind. GPUI's own such cases (a `div`'s
    /// drag, drop, tooltip or group style, deferred draws, input handlers)
    /// are found and never moved.
    pub fn movable(mut self, movable: bool) -> Self {
        self.movable = movable;
        self
    }

    /// Whether it may be left undrawn while nothing of it shows: nothing
    /// inside needs its listeners while the pointer can't be over it (a
    /// hover callback waiting to hear the pointer left would not). What takes
    /// keys or focus is found and always drawn.
    pub fn skippable(mut self, skippable: bool) -> Self {
        self.skippable = skippable;
        self
    }

    // mirin: port of the fork's `Retained::stretchable` (`docs/metal.md`, 5b,
    // resize round 5).
    /// Whether its root draws nothing from its own size (no fill, border,
    /// shadow, clip or hitbox): resized with nothing below it changed (a row
    /// stretched to a window's new width), its drawing is what it would
    /// draw at the new size, and is kept.
    pub fn stretchable(mut self, stretchable: bool) -> Self {
        self.stretchable = stretchable;
        self
    }
}

/// What a subtree is laid out and drawn under, apart from where: a change
/// builds it again.
#[derive(PartialEq)]
struct Statics {
    text_style: TextStyle,
    scale_factor: f32,
    rem_size: Pixels,
    opacity: u32,
}

impl Statics {
    fn of(window: &Window) -> Self {
        Self {
            text_style: window.text_style(),
            scale_factor: window.scale_factor(),
            rem_size: window.rem_size(),
            opacity: window.element_opacity().to_bits(),
        }
    }
}

type Record = Rc<RefCell<Drawn>>;

struct RetainedState {
    version: u64,
    /// Its taffy subtree's root, kept across frames.
    root: LayoutId,
    /// The taffy nodes it made (not those of the retained subtrees inside),
    /// in the order it made them, and the layout they were made for.
    owned: Vec<LayoutId>,
    made: u64,
    released: Rc<RefCell<Vec<LayoutId>>>,
    statics: Statics,
    drawn: Record,
    /// Every retained subtree inside, at any depth.
    nested: Vec<Record>,
    accessed_entities: FxHashSet<EntityId>,
    /// Its nodes can't be built onto again (`rebuild`): made anew the next
    /// time it is laid out.
    remake: bool,
    /// Its elements' states (and with them the retained subtrees' inside)
    /// as last drawn: they stay here while it is copied or left out
    /// (`ElementStateScope`).
    states: ElementStates,
    /// While it is drawn anew this frame: its elements' states between
    /// phases.
    drawing: Option<ElementStateScope>,
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
    /// Its layout root this frame.
    root: LayoutId,
}

#[doc(hidden)]
pub enum RetainedPrepaint {
    /// Drawn this frame, and what its prepaint recorded.
    Drawn(AnyElement, Recorded),
    /// Last frame's drawing is copied as it is.
    Reused,
    /// Last frame's drawing is copied `by` device pixels on, from under the
    /// content mask `old_mask`.
    Moved {
        by: Point<f32>,
        old_mask: ContentMask<Pixels>,
    },
    /// Nothing of it shows: not drawn.
    Skipped,
}

/// Build the subtree's element and request its layout; with `owned`, the
/// nodes it makes are its own and kept across frames.
fn build_layout(
    build: &Build,
    owned: bool,
    window: &mut Window,
    cx: &mut App,
) -> (AnyElement, LayoutId, Vec<LayoutId>) {
    let mut element = build(window, cx);
    if owned {
        window.layout_engine_mut().begin_owned();
    }
    let root = element.request_layout(window, cx);
    let nodes = if owned {
        window.layout_engine_mut().end_owned()
    } else {
        Vec::new()
    };
    (element, root, nodes)
}

/// Run `f` with a retained subtree's element states (`prev`, from its last
/// drawing) as the ones elements find and keep; what they hold after.
fn with_states<R>(
    prev: ElementStates,
    window: &mut Window,
    f: impl FnOnce(&mut Window) -> R,
) -> (R, ElementStateScope) {
    with_scope(
        ElementStateScope {
            prev,
            next: ElementStates::default(),
        },
        window,
        f,
    )
}

/// Run `f` with `scope` as the element states elements find and keep.
fn with_scope<R>(
    scope: ElementStateScope,
    window: &mut Window,
    f: impl FnOnce(&mut Window) -> R,
) -> (R, ElementStateScope) {
    window.element_state_scopes.push(scope);
    let result = f(window);
    let scope = window
        .element_state_scopes
        .pop()
        .expect("a scope pushed is popped");
    (result, scope)
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
        let binding = window.retained_binding > 0 && window.retained_detached == 0;
        let (view, version) = (self.view, self.version);
        let build = self.build.clone();
        window.with_element_state::<RetainedState, _>(global_id, |mut state, window| {
            if let Some(state) = &mut state {
                state.settle_states();
            }
            let statics = Statics::of(window);
            let unchanged = state.as_ref().is_some_and(|state| {
                state.version == version
                    && !state.remake
                    && state.statics == statics
                    && !window.dirty_views.contains(&view)
                    && window.layout_engine_mut().contains(state.root)
            });
            // Inside a subtree built again onto its kept nodes, one that
            // changed can't be answered by them: that subtree is built
            // apart instead (and this one with it, again).
            if binding && !unchanged {
                window.layout_engine_mut().fail_bind();
            }
            let detached = window.retained_detached > 0 || (binding && !unchanged);
            let clean = !detached && unchanged;
            match state {
                // Clean: its kept nodes go into this frame's tree as they are.
                Some(state) if clean => {
                    let layout = RetainedLayout {
                        element: None,
                        root: state.root,
                    };
                    ((state.root, layout), state)
                }
                // Inside a subtree laid out apart: built with it, its kept
                // nodes left as they are (they are the tree's).
                Some(mut state) if detached => {
                    let prev = std::mem::take(&mut state.states);
                    let ((element, root, _), drawing) = with_states(prev, window, |window| {
                        window.with_rendered_view(view, |window| {
                            build_layout(&build, false, window, cx)
                        })
                    });
                    state.drawing = Some(drawing);
                    state.statics = statics;
                    let layout = RetainedLayout {
                        element: Some(element),
                        root,
                    };
                    ((root, layout), state)
                }
                mut state => {
                    let prev = state
                        .as_mut()
                        .map(|state| std::mem::take(&mut state.states))
                        .unwrap_or_default();
                    let ((element, root, owned), drawing) = with_states(prev, window, |window| {
                        window.with_rendered_view(view, |window| {
                            build_layout(&build, !detached, window, cx)
                        })
                    });
                    let released = window.layout_engine_mut().released();
                    let drawn = state
                        .as_ref()
                        .map_or_else(Record::default, |state| state.drawn.clone());
                    // The state before goes, and its nodes with it (`Drop`).
                    drop(state);
                    let state = RetainedState {
                        version,
                        root,
                        owned,
                        made: window.layout_engine_mut().epoch(),
                        released,
                        statics,
                        drawn,
                        nested: Vec::new(),
                        accessed_entities: FxHashSet::default(),
                        states: ElementStates::default(),
                        drawing: Some(drawing),
                        remake: false,
                    };
                    let layout = RetainedLayout {
                        element: Some(element),
                        root,
                    };
                    ((root, layout), state)
                }
            }
        })
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
        let view = self.view;
        window.set_view_id(view);
        let built = layout.element.take();
        let root = layout.root;
        let build = self.build.clone();
        let movable = self.movable;
        let skippable = self.skippable;
        let stretchable = self.stretchable;
        let on_prepaint = self.on_prepaint.take();
        window.with_rendered_view(view, |window| {
            window.with_element_state::<RetainedState, _>(global_id, |state, window| {
                let mut state =
                    state.expect("a retained subtree is laid out before it is prepainted");
                let mask = window.content_mask();
                let place = Place::of(root, window);
                // A view inside it that was notified must be drawn: one left
                // undrawn would not hear of it again.
                let notified = window
                    .dirty_views
                    .iter()
                    .any(|view| state.accessed_entities.contains(view));
                let below_same = !window
                    .layout_engine_mut()
                    .below_changed_since(root, state.drawn.borrow().epoch);
                let allowed = Allowed {
                    movable,
                    skippable: skippable && !notified,
                    below_same,
                };
                // mirin: only its root was resized, and its root draws
                // nothing from its size: the drawing is of this layout.
                if stretchable && below_same && built.is_none() {
                    state.drawn.borrow_mut().stretch(bounds.size, place, window);
                }
                let mut plan = match &built {
                    Some(_) => Plan::Redraw,
                    None => plan(&state.drawn.borrow(), bounds, &mask, place, allowed, window),
                };
                // It shows again: its parked drawing goes back among last
                // frame's, where it was drawn, and is copied from there.
                if built.is_none() && matches!(plan, Plan::Redraw) && state.unpark(window) {
                    plan = self::plan(&state.drawn.borrow(), bounds, &mask, place, allowed, window);
                }
                let draw = match (&built, &plan) {
                    (Some(_), _) => RetainedDraw::Built,
                    (None, Plan::Skip) => RetainedDraw::Skipped,
                    (None, Plan::Reuse) => RetainedDraw::Reused,
                    (None, Plan::Move { .. }) => RetainedDraw::Moved,
                    (None, Plan::Redraw) => RetainedDraw::Redrawn,
                };
                if let Some(on_prepaint) = on_prepaint {
                    on_prepaint(draw, bounds, window, cx);
                }
                if !matches!(plan, Plan::Redraw) {
                    cx.entities
                        .extend_accessed(state.accessed_entities.iter().copied());
                }
                let prepaint = match plan {
                    Plan::Skip => {
                        state.skip(bounds, place, window);
                        RetainedPrepaint::Skipped
                    }
                    Plan::Reuse => {
                        state.copy_prepaint(None, window);
                        RetainedPrepaint::Reused
                    }
                    Plan::Move { by, by_layout } => {
                        let old_mask = state
                            .drawn
                            .borrow()
                            .mask
                            .clone()
                            .expect("a moved drawing knows its mask");
                        state.copy_prepaint(Some((by, by_layout, &old_mask)), window);
                        RetainedPrepaint::Moved { by, old_mask }
                    }
                    Plan::Redraw => {
                        let mut element = match built {
                            Some(element) => element,
                            // Its layout kept (or, failing that, laid out
                            // apart), its elements built again.
                            None => {
                                let prev = std::mem::take(&mut state.states);
                                let (element, drawing) = with_states(prev, window, |window| {
                                    state.rebuild(&build, view, window, cx)
                                });
                                state.drawing = Some(drawing);
                                element
                            }
                        };
                        let start = window.prepaint_index();
                        window.retained_nested.push(Vec::new());
                        window.begin_recording(None);
                        let drawing = state.drawing.take().unwrap_or_default();
                        let ((_, accessed), drawing) = with_scope(drawing, window, |window| {
                            cx.detect_accessed_entities(|cx| element.prepaint(window, cx))
                        });
                        state.drawing = Some(drawing);
                        let recorded = window.end_recording();
                        state.nested = window.retained_nested.pop().unwrap_or_default();
                        state.accessed_entities = accessed;
                        let end = window.prepaint_index();
                        let mut drawn = state.drawn.borrow_mut();
                        drawn.prepaint = Some(start..end);
                        drawn.bounds = bounds;
                        drawn.mask = Some(mask);
                        drawn.place = place;
                        drawn.epoch = window.layout_engine_mut().epoch();
                        // Known once it is painted.
                        drawn.recorded = None;
                        drop(drawn);
                        RetainedPrepaint::Drawn(element, recorded)
                    }
                };
                // The subtree around it (if any) moves this one's ranges, and
                // the ones inside it, along when it is copied.
                if let Some(around) = window.retained_nested.last_mut() {
                    around.push(state.drawn.clone());
                    around.extend(state.nested.iter().cloned());
                }
                cx.entities.extend_accessed([view]);
                (prepaint, state)
            })
        })
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
        window.with_rendered_view(view, |window| {
            window.with_element_state::<RetainedState, _>(global_id, |state, window| {
                let mut state =
                    state.expect("a retained subtree is prepainted before it is painted");
                let start = window.paint_index();
                match prepaint {
                    RetainedPrepaint::Drawn(element, recorded) => {
                        window.begin_recording(Some(*recorded));
                        let drawing = state.drawing.take().unwrap_or_default();
                        let (((), accessed), drawing) = with_scope(drawing, window, |window| {
                            cx.detect_accessed_entities(|cx| element.paint(window, cx))
                        });
                        // What it no longer uses goes (`drawing.prev`).
                        state.states = drawing.next;
                        let recorded = window.end_recording();
                        state.accessed_entities.extend(accessed);
                        state.drawn.borrow_mut().recorded = Some(recorded);
                    }
                    RetainedPrepaint::Reused => state.copy_paint(None, window),
                    RetainedPrepaint::Moved { by, .. } => state.copy_paint(Some(*by), window),
                    RetainedPrepaint::Skipped => {}
                }
                let end = window.paint_index();
                let mut drawn = state.drawn.borrow_mut();
                // Left out, it is a hole in the drawing around it.
                if let (RetainedPrepaint::Skipped, Some(recorded)) =
                    (&prepaint, &mut drawn.recorded)
                {
                    recorded.left_out = recorded.extent;
                }
                if let RetainedPrepaint::Drawn(..) = prepaint
                    && let Some(prepaint) = &drawn.prepaint
                {
                    drawn.inert = window.drawing_is_inert(prepaint, &(start.clone()..end.clone()));
                }
                if !matches!(prepaint, RetainedPrepaint::Skipped) {
                    drawn.paint = Some(start..end);
                    drawn.pointer = window.mouse_position();
                }
                // The subtree around it, if it is being drawn anew, takes in
                // what this one's drawing is; one not known can't be moved.
                let recorded = drawn.recorded.unwrap_or(Recorded {
                    pinned: true,
                    ..Recorded::default()
                });
                drop(drawn);
                window.absorb_retained(&recorded);
                ((), state)
            })
        });
    }
}

impl RetainedState {
    /// Its element states back in one map, should a drawing begun last
    /// frame not have been painted.
    fn settle_states(&mut self) {
        if let Some(drawing) = self.drawing.take() {
            self.states.extend(drawing.prev);
            self.states.extend(drawing.next);
        }
    }

    /// Leave it undrawn at `bounds`: its drawing, with the ones inside,
    /// leaves the frame (its element states are its own already).
    fn skip(&mut self, bounds: Bounds<Pixels>, place: Option<Place>, window: &mut Window) {
        let parked = {
            let drawn = self.drawn.borrow();
            // Only a drawing that may be copied elsewhere is of use, and not
            // one the pointer is over (it may show hover styles no pointer
            // move takes away while it is out of the frame), nor one only
            // resized while out of view (it is stale).
            let hovered = drawn
                .recorded
                .and_then(|recorded| recorded.extent)
                .is_some_and(|extent| {
                    extent.contains(&drawn.pointer) || extent.contains(&window.mouse_position())
                });
            let resized = drawn.place.map(|place| place.node) != place.map(|place| place.node);
            let pinned = drawn.recorded.is_none_or(|recorded| recorded.pinned);
            (!hovered && !resized && !pinned)
                .then(|| window.park(&self.drawn, &drawn, &self.nested))
                .flatten()
        };
        let mut drawn = self.drawn.borrow_mut();
        if parked.is_some() {
            drawn.parked = parked;
        }
        drawn.skip(bounds, place);
        for nested in &self.nested {
            let mut nested = nested.borrow_mut();
            nested.prepaint = None;
            nested.paint = None;
        }
    }

    /// Put its parked drawing (if it has one and no drawing in last frame)
    /// back at the end of last frame's lists, with its record as it was
    /// drawn; whether it did.
    fn unpark(&mut self, window: &mut Window) -> bool {
        let parked = {
            let mut drawn = self.drawn.borrow_mut();
            if drawn.prepaint.is_some() {
                return false;
            }
            match drawn.parked.take() {
                Some(parked) => parked,
                None => return false,
            }
        };
        let mut drawn = self.drawn.borrow_mut();
        drawn.bounds = parked.bounds;
        drawn.mask = parked.mask.clone();
        drawn.place = parked.place;
        drawn.recorded = parked.recorded;
        drawn.epoch = parked.epoch;
        drawn.pointer = parked.pointer;
        let ((prepaint, paint), nested) = window.unpark(parked);
        drawn.prepaint = Some(prepaint);
        drawn.paint = Some(paint);
        drop(drawn);
        for (record, ranges) in self.nested.iter().zip(nested) {
            let mut record = record.borrow_mut();
            (record.prepaint, record.paint) = match ranges {
                Some((prepaint, paint)) => (Some(prepaint), Some(paint)),
                None => (None, None),
            };
        }
        true
    }

    /// Build its element again for the layout it kept: each element asks
    /// for the node it made last time (`TaffyLayoutEngine::begin_bind`), so
    /// nothing is laid out, and the retained subtrees inside keep theirs and
    /// are each drawn their own way. When they ask for anything else, or a
    /// measured leaf was asked again since (what it holds may not be what a
    /// layout from nothing would leave), it is built apart instead.
    fn rebuild(
        &mut self,
        build: &Build,
        view: EntityId,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let engine = window.layout_engine_mut();
        if engine.any_asked_since(&self.owned, self.made) {
            // What its texts hold is not what a layout from nothing leaves
            // them with: built apart now, and made anew next time it is laid
            // out, so later frames can build onto its nodes again.
            self.remake = true;
        } else {
            engine.begin_bind(self.owned.clone());
            window.retained_binding += 1;
            let (element, root) = window.with_rendered_view(view, |window| {
                let mut element = build(window, cx);
                let root = element.request_layout(window, cx);
                (element, root)
            });
            window.retained_binding -= 1;
            let bound = window.end_bind(cx);
            if bound && root == self.root {
                return element;
            }
            // What it kept from its last drawing, whichever half the try took.
            if let Some(scope) = window.element_state_scopes.last_mut() {
                let used = std::mem::take(&mut scope.next);
                scope.prev.extend(used);
            }
        }
        self.build_apart(build, window, cx)
    }

    /// Build its element again, apart from the tree, laid out as its kept
    /// nodes sit (`TaffyLayoutEngine::place_detached`).
    fn build_apart(&mut self, build: &Build, window: &mut Window, cx: &mut App) -> AnyElement {
        APART.with(|apart| apart.set(apart.get() + 1));
        window.retained_detached += 1;
        let (element, root, _) = build_layout(build, false, window, cx);
        window.retained_detached -= 1;
        let size = window.layout_engine_mut().place_detached(root, self.root);
        window.compute_layout(
            root,
            size.map(|length| AvailableSpace::Definite(length / window.scale_factor())),
            cx,
        );
        element
    }

    /// Copy last frame's prepaint where it was, or `moved` (device pixels,
    /// those of them laid out elsewhere, and the mask it was under).
    fn copy_prepaint(
        &mut self,
        moved: Option<(Point<f32>, Point<f32>, &ContentMask<Pixels>)>,
        window: &mut Window,
    ) {
        let start = window.prepaint_index();
        let old = self.drawn.borrow().prepaint.clone().unwrap_or_default();
        let mask = window.content_mask();
        let scale = window.scale_factor();
        match moved {
            Some((by, ..)) => window.reuse_prepaint_moved(old.clone(), by),
            None => window.reuse_prepaint(old.clone()),
        }
        let end = window.prepaint_index();
        let pointer = window.mouse_position();
        for nested in &self.nested {
            let mut nested = nested.borrow_mut();
            nested.pointer = pointer;
            nested.prepaint = nested.prepaint.as_ref().map(|range| {
                range.start.rebase(&old.start, &start)..range.end.rebase(&old.start, &start)
            });
            if let Some((by, by_layout, old_mask)) = moved {
                nested.shift(by, by_layout, scale, (old_mask, &mask));
            }
        }
        let mut drawn = self.drawn.borrow_mut();
        if let Some((by, by_layout, old_mask)) = moved {
            drawn.shift(by, by_layout, scale, (old_mask, &mask));
        }
        drawn.prepaint = Some(start..end);
    }

    /// Copy last frame's paint where it was, or `moved`.
    fn copy_paint(&mut self, moved: Option<Point<f32>>, window: &mut Window) {
        let start = window.paint_index();
        let old = self.drawn.borrow().paint.clone().unwrap_or_default();
        window.reuse_paint_moved(old.clone(), moved, true);
        for nested in &self.nested {
            let mut nested = nested.borrow_mut();
            nested.paint = nested.paint.as_ref().map(|range| {
                range.start.rebase(&old.start, &start)..range.end.rebase(&old.start, &start)
            });
        }
    }
}
