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
//! - anywhere else: its elements are built again and laid out apart from the
//!   tree, as the nodes it kept are laid out (`TaffyLayoutEngine::place_detached`),
//!   and drawn; the retained subtrees inside are built with it.
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
//! Not yet (the fork's `../gpui` has them): copying a drawing that moved,
//! leaving out one nothing of shows, and building one again onto the layout
//! nodes it kept.

use std::{cell::RefCell, ops::Range, rc::Rc};

use collections::FxHashSet;

use crate::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, Element, ElementId, EntityId,
    GlobalElementId, InspectorElementId, LayoutId, PaintIndex, Pixels,
    PrepaintStateIndex, TextStyle, Window,
};

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
    /// moves. Moves are not copied yet on this GPUI: accepted and unused.
    pub fn movable(self, _movable: bool) -> Self {
        self
    }

    /// Whether it may be left undrawn while nothing of it shows. Not done
    /// yet on this GPUI: accepted and unused.
    pub fn skippable(self, _skippable: bool) -> Self {
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

/// A retained subtree's last drawing: where it is in last frame's lists and
/// where it was drawn. Shared with the subtrees around it, which move its
/// ranges along when they copy their own.
#[derive(Default)]
pub(crate) struct Drawn {
    prepaint: Option<Range<PrepaintStateIndex>>,
    paint: Option<Range<PaintIndex>>,
    bounds: Bounds<Pixels>,
    mask: Option<ContentMask<Pixels>>,
}

type Record = Rc<RefCell<Drawn>>;

struct RetainedState {
    version: u64,
    /// Its taffy subtree's root, kept across frames.
    root: LayoutId,
    /// The taffy nodes it made (not those of the retained subtrees inside).
    owned: Vec<LayoutId>,
    released: Rc<RefCell<Vec<LayoutId>>>,
    statics: Statics,
    drawn: Record,
    /// Every retained subtree inside, at any depth.
    nested: Vec<Record>,
    accessed_entities: FxHashSet<EntityId>,
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
pub enum RetainedPrepaint {
    /// Drawn this frame.
    Drawn(AnyElement),
    /// Last frame's drawing is copied as it is.
    Reused,
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
        let detached = window.retained_detached > 0;
        let (view, version) = (self.view, self.version);
        let build = self.build.clone();
        window.with_element_state::<RetainedState, _>(global_id, |state, window| {
            let statics = Statics::of(window);
            let clean = !detached
                && state.as_ref().is_some_and(|state| {
                    state.version == version
                        && state.statics == statics
                        && !window.dirty_views.contains(&view)
                        && window.layout_engine_mut().contains(state.root)
                });
            match state {
                // Clean: its kept nodes go into this frame's tree as they are.
                Some(state) if clean => ((state.root, RetainedLayout { element: None }), state),
                // Inside a subtree laid out apart: built with it, its kept
                // nodes left as they are (they are the tree's).
                Some(mut state) if detached => {
                    let (element, root, _) =
                        window.with_rendered_view(view, |window| build_layout(&build, false, window, cx));
                    state.statics = statics;
                    let layout = RetainedLayout {
                        element: Some(element),
                    };
                    ((root, layout), state)
                }
                state => {
                    let (element, root, owned) = window.with_rendered_view(view, |window| {
                        build_layout(&build, !detached, window, cx)
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
                        released,
                        statics,
                        drawn,
                        nested: Vec::new(),
                        accessed_entities: FxHashSet::default(),
                    };
                    let layout = RetainedLayout {
                        element: Some(element),
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
        let build = self.build.clone();
        let on_prepaint = self.on_prepaint.take();
        window.with_rendered_view(view, |window| {
            window.with_element_state::<RetainedState, _>(global_id, |state, window| {
                let mut state =
                    state.expect("a retained subtree is laid out before it is prepainted");
                let mask = window.content_mask();
                let reusable = built.is_none() && {
                    let drawn = state.drawn.borrow();
                    drawn.bounds == bounds
                        && drawn.mask.as_ref() == Some(&mask)
                        && drawn.prepaint.as_ref().is_some_and(|range| {
                            window.prepaint_range_valid(range)
                                && drawn
                                    .paint
                                    .as_ref()
                                    .is_some_and(|range| window.paint_range_valid(range))
                        })
                };
                let draw = match (&built, reusable) {
                    (Some(_), _) => RetainedDraw::Built,
                    (None, true) => RetainedDraw::Reused,
                    (None, false) => RetainedDraw::Redrawn,
                };
                if let Some(on_prepaint) = on_prepaint {
                    on_prepaint(draw, bounds, window, cx);
                }
                let prepaint = if reusable {
                    let start = window.prepaint_index();
                    let old = state.drawn.borrow().prepaint.clone().unwrap_or_default();
                    window.reuse_prepaint(old.clone());
                    let end = window.prepaint_index();
                    for nested in &state.nested {
                        let mut nested = nested.borrow_mut();
                        nested.prepaint = nested.prepaint.as_ref().map(|range| {
                            range.start.rebase(&old.start, &start)..range.end.rebase(&old.start, &start)
                        });
                    }
                    state.drawn.borrow_mut().prepaint = Some(start..end);
                    cx.entities
                        .extend_accessed(state.accessed_entities.iter().copied());
                    RetainedPrepaint::Reused
                } else {
                    let element = match built {
                        Some(element) => element,
                        // Somewhere else, or at another size: built again
                        // and laid out apart, as its kept nodes sit.
                        None => {
                            APART.with(|apart| apart.set(apart.get() + 1));
                            window.retained_detached += 1;
                            let (element, root, _) = build_layout(&build, false, window, cx);
                            window.retained_detached -= 1;
                            let size = window.layout_engine_mut().place_detached(root, state.root);
                            window.compute_layout(
                                root,
                                size.map(|length| {
                                    AvailableSpace::Definite(length / window.scale_factor())
                                }),
                                cx,
                            );
                            element
                        }
                    };
                    let mut element = element;
                    let start = window.prepaint_index();
                    window.retained_nested.push(Vec::new());
                    let (_, accessed) =
                        cx.detect_accessed_entities(|cx| element.prepaint(window, cx));
                    state.nested = window.retained_nested.pop().unwrap_or_default();
                    state.accessed_entities = accessed;
                    let end = window.prepaint_index();
                    let mut drawn = state.drawn.borrow_mut();
                    drawn.prepaint = Some(start..end);
                    drawn.bounds = bounds;
                    drawn.mask = Some(mask);
                    drop(drawn);
                    RetainedPrepaint::Drawn(element)
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
                    RetainedPrepaint::Drawn(element) => {
                        let ((), accessed) =
                            cx.detect_accessed_entities(|cx| element.paint(window, cx));
                        state.accessed_entities.extend(accessed);
                    }
                    RetainedPrepaint::Reused => {
                        let old = state.drawn.borrow().paint.clone().unwrap_or_default();
                        window.reuse_paint(old.clone());
                        for nested in &state.nested {
                            let mut nested = nested.borrow_mut();
                            nested.paint = nested.paint.as_ref().map(|range| {
                                range.start.rebase(&old.start, &start)
                                    ..range.end.rebase(&old.start, &start)
                            });
                        }
                    }
                }
                let end = window.paint_index();
                state.drawn.borrow_mut().paint = Some(start..end);
                ((), state)
            })
        });
    }
}

