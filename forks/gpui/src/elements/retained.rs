//! mirin: a subtree kept across frames.
//!
//! GPUI builds, lays out, prepaints and paints the whole element tree every
//! frame. A [`Retained`] subtree is built only when its content changed: the
//! caller names it with a stable id, a view id and a content `version`, and
//! while the version is the same and nothing inside it was notified, the
//! subtree is not built again. Its taffy nodes stay in the tree (with their
//! layout cache, so taffy skips the subtree unless its constraints changed),
//! and each frame it is drawn the cheapest way that gives what drawing it
//! anew would ([`RetainedDraw`]):
//!
//! - where it was, under the same content mask: last frame's hitboxes,
//!   dispatch nodes, listeners and scene primitives are copied;
//! - somewhere else, laid out as it was (it scrolled, or what is above it
//!   grew): the same are copied, moved, each under the content mask it has
//!   there (`recording`). Only by whole device pixels between places on
//!   the device grid (`grid`), and only a drawing that is whole where it
//!   now shows; the caller says it may be ([`Retained::movable`]);
//! - where nothing of it shows: nothing at all, if the caller says so
//!   ([`Retained::skippable`]); its drawing is put aside, within a budget,
//!   and copied back when it shows again (`parked`);
//! - otherwise its elements are built again and drawn, onto the layout it
//!   kept (`TaffyLayoutEngine::begin_bind`), so nothing is laid out and the
//!   retained subtrees inside it are each drawn their own cheapest way.
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

use std::{cell::RefCell, rc::Rc};

use collections::FxHashMap;

use crate::{
    AnyElement, App, Bounds, Element, ElementId, EntityId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, Window, window::ElementStateBox,
};

mod draw;
mod grid;
mod masks;
mod moved;
mod parked;
mod recording;
mod region;
mod state;

#[doc(hidden)]
pub use draw::take_built_apart;
pub(crate) use grid::Grid;
pub(crate) use masks::{MaskMap, MaskNode};
pub(crate) use parked::Parking;
pub(crate) use recording::{PlacedGlyphX, Recording};
pub(crate) use state::Drawn;
use state::{Plan, RetainedState, Statics};

type Build = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;
type OnPrepaint = Box<dyn FnOnce(RetainedDraw, Bounds<Pixels>, &mut Window, &mut App)>;
type States = FxHashMap<(GlobalElementId, std::any::TypeId), ElementStateBox>;

/// A subtree built only when its content changed. See the module docs.
pub struct Retained {
    id: ElementId,
    view: EntityId,
    version: u64,
    build: Build,
    on_prepaint: Option<OnPrepaint>,
    movable: bool,
    skippable: bool,
}

/// How a retained subtree was drawn this frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RetainedDraw {
    /// Built (its content changed, or it was notified) and drawn.
    Built,
    /// Its elements were built again for the layout it kept, and drawn.
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
/// subtree must be drawn anew (more than once a frame, at most). `id` must
/// be stable; `view` names it to notifications (an entity the caller keeps,
/// one per subtree).
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
    /// tooltip, deferred draws, input handlers, layers) are found and never
    /// moved.
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
}

/// A retained subtree's last drawing, shared with the subtrees around it,
/// which move it along when they copy their own.
pub(crate) struct RetainedRecord {
    view: EntityId,
    pub(crate) drawn: RefCell<Drawn>,
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
    /// Last frame's drawing is copied, this many device pixels from where
    /// it was (`None`: as it is); `whole`: what shows of it is what did.
    Reused {
        moved: Option<Point<f32>>,
        whole: bool,
    },
    Skipped,
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
        let detached = window.retained_detached > 0;
        let binding = window.retained_binding;
        let (view, version) = (self.view, self.version);
        let build = self.build.clone();
        let (layout_id, element) =
            window.with_element_state::<RetainedState, _>(global_id, |state, window| {
                let kept = state.as_ref().is_some_and(|state| {
                    state.version == version && window.layout_engine().contains(state.root)
                });
                if binding && !detached {
                    // Inside a subtree built again onto its kept layout: its
                    // kept nodes answer, and how it is drawn is decided
                    // where it lands.
                    return match state {
                        Some(state) if kept => ((state.root, None), state),
                        // Not as it was when the layout was kept: the
                        // subtree around it is built apart instead (and
                        // this again).
                        state => {
                            window.layout_engine().fail_bind();
                            let (root, element, state) =
                                draw::build_layout(state, view, version, &build, true, window, cx);
                            ((root, Some(element)), state)
                        }
                    };
                }
                let reusable = kept
                    && !detached
                    && state.as_ref().is_some_and(|state| {
                        state.record.drawn.borrow().known
                            && !state.is_dirty(view, window)
                            && state.statics.as_ref() == Some(&Statics::of(window))
                    });
                match state {
                    // Clean: its kept nodes go into this frame's tree as they are.
                    Some(state) if reusable => ((state.root, None), state),
                    state => {
                        let (root, element, state) =
                            draw::build_layout(state, view, version, &build, detached, window, cx);
                        ((root, Some(element)), state)
                    }
                }
            });
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
        let view = self.view;
        let built = layout.element.take();
        let build = self.build.clone();
        let (movable, skippable) = (self.movable, self.skippable);
        let on_prepaint = self.on_prepaint.take();
        window.with_element_state::<RetainedState, _>(global_id, |state, window| {
            let mut state = state.expect("a retained subtree is laid out before it is prepainted");
            let plan = match built {
                Some(element) => Plan::Draw(element),
                None => state.plan(bounds, movable, skippable, window),
            };
            if let Some(on_prepaint) = on_prepaint {
                on_prepaint(plan.draw(), bounds, window, cx);
            }
            let prepaint = match plan {
                Plan::Skip => {
                    state.skip(bounds, window);
                    RetainedPrepaint::Skipped
                }
                Plan::Reuse { moved, whole } => {
                    state.reuse_prepaint(bounds, moved, window);
                    RetainedPrepaint::Reused { moved, whole }
                }
                Plan::Draw(mut element) => {
                    state.draw_prepaint(&mut element, bounds, None, view, window, cx);
                    RetainedPrepaint::Drawn(element)
                }
                Plan::Redraw => {
                    let (mut element, apart) = state.rebuild(&build, bounds, view, window, cx);
                    state.draw_prepaint(&mut element, bounds, apart, view, window, cx);
                    RetainedPrepaint::Drawn(element)
                }
            };
            let mut accessed = cx.entities.accessed_entities.borrow_mut();
            accessed.insert(view);
            if !matches!(prepaint, RetainedPrepaint::Drawn(_)) {
                // Nothing inside ran: the views in it are still drawn (or
                // waited on) by this window.
                accessed.extend(state.nested.iter().map(|record| record.view));
                drop(accessed);
                window.absorb_retained(&state.record, &state.nested, false);
            }
            (prepaint, state)
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
        // Left out: nothing to paint, and its state (which layout and
        // prepaint already carried into this frame) need not be looked up.
        if matches!(prepaint, RetainedPrepaint::Skipped) {
            return;
        }
        let global_id = global_id.expect("a retained subtree has an id");
        let (view, skippable) = (self.view, self.skippable);
        window.with_element_state::<RetainedState, _>(global_id, |state, window| {
            let mut state = state.expect("a retained subtree is prepainted before it is painted");
            match prepaint {
                RetainedPrepaint::Drawn(element) => {
                    state.draw_paint(element, skippable, view, window, cx)
                }
                RetainedPrepaint::Reused { moved, whole } => {
                    state.reuse_paint(*moved, *whole, window)
                }
                RetainedPrepaint::Skipped => {}
            }
            ((), state)
        });
    }
}

#[cfg(test)]
mod tests;
