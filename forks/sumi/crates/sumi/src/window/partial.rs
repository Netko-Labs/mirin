//! Partial frames: the frame the window keeps, edited in place
//! (`docs/metal/engine.md`, section 3).
//!
//! A frame is built from the root: every view rendered, laid out, walked,
//! what did not change copied from the frame before. When all that changed
//! since that frame is the content of retained subtrees
//! (`elements::retained`), nothing else needs to run. A partial frame draws
//! each of those subtrees again into the frame it was last drawn in:
//!
//! - its elements are built onto the layout nodes it kept, which must hold
//!   what they ask for (`TaffyLayoutEngine::begin_bind`, strict), so nothing
//!   is laid out;
//! - it is prepainted and painted under what it was drawn under (kept with
//!   its record), each list of the frame writing over the range the
//!   subtree filled last time (`FrameVec`, `DispatchTree::begin_patch`,
//!   `Scene::begin_patch`, `LineLayoutCache::begin_patch`);
//! - what it writes must be of the shape of what it replaces. If it is
//!   not, or anything else about it can't be drawn so, the partial frame
//!   is given up and the frame is drawn in full, as if it had not been
//!   tried: a full frame draws every changed subtree anew and takes from
//!   the frame before only the drawings of subtrees that did not change,
//!   which a partial frame never writes into.
//!
//! A host opts in (`Window::set_partial_frames`) and hears of each one: it
//! keeps state per frame of its own (a layout map, an accessibility tree).
//! Nothing but retained subtrees being notified makes one: a refresh, a
//! resize, a view that is no retained subtree, a prompt, a drag or a
//! tooltip showing are all full frames.

use std::rc::Rc;

use collections::FxHashMap;
use smallvec::SmallVec;

use super::{DrawPhase, Window};
use crate::{
    App, ContentMask, ElementId, EntityId, GlobalElementId, Pixels, Point, TextStyleRefinement,
};

mod lists;

/// What a host hears of a partial frame (`Window::set_partial_frames`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PartialFrame {
    /// One is about to be tried.
    Begin,
    /// It is over. `drawn`: the frame the window shows is the one before
    /// with the changed subtrees drawn again in it. Otherwise it was given
    /// up, and a full frame follows at once.
    End {
        /// Whether the partial frame was drawn.
        drawn: bool,
    },
}

/// The host's ear for partial frames.
pub(crate) type PartialHook = Rc<dyn Fn(PartialFrame, &mut Window, &mut App)>;

/// The most retained subtrees a partial frame draws: past it (a theme
/// change touches every one) the frame is drawn in full.
const MOST_ROOTS: usize = 32;

/// A retained subtree the window knows by the entity it is notified by.
pub(crate) struct RetainedEntry {
    /// Where its state is.
    pub(crate) id: GlobalElementId,
    /// The view it is built in: a retained subtree's, or not.
    pub(crate) parent: Option<EntityId>,
    /// The version its content is at, when the host said
    /// (`Window::set_retained_version`).
    pub(crate) version: Option<u64>,
}

/// A partial frame being drawn.
#[derive(Default)]
pub(crate) struct Partial {
    /// Something asked for what a partial frame can't draw.
    failed: bool,
    /// The entities the subtrees drawn read.
    accessed: Vec<EntityId>,
}

/// What a retained subtree is drawn under, apart from where
/// (`elements::retained::in_place`).
pub(crate) struct InPlace<'a> {
    pub(crate) id: &'a GlobalElementId,
    pub(crate) view: EntityId,
    pub(crate) text_styles: &'a [TextStyleRefinement],
    pub(crate) rem_size: Pixels,
    pub(crate) opacity: f32,
    pub(crate) offset: Point<Pixels>,
    pub(crate) mask: &'a ContentMask<Pixels>,
}

/// Where the lists that only grow in a partial frame's build ended before
/// it (`Window::in_place_marks`).
pub(crate) struct Marks {
    accessed_element_states: usize,
    layouts: crate::LineLayoutIndex,
}

impl Window {
    /// Draw partial frames (`PartialFrame`), telling `hook` of each; `None`
    /// (as a window begins): every frame is drawn in full.
    pub fn set_partial_frames(
        &mut self,
        hook: Option<impl Fn(PartialFrame, &mut Window, &mut App) + 'static>,
    ) {
        self.partial_hook = hook.map(|hook| Rc::new(hook) as PartialHook);
    }

    /// The content of the retained subtree notified by `view` changed, to
    /// `version`: it is drawn in the next frame, whether or not the window
    /// heard its entity notified, and a partial frame, which makes no
    /// element for it, takes its version from here, so the next element
    /// made for it with that version finds it unchanged. `false`: the
    /// window knows no such retained subtree (it was never laid out), and
    /// nothing was marked.
    pub fn set_retained_version(&mut self, view: EntityId, version: u64) -> bool {
        let Some(entry) = self.retained_views.get_mut(&view) else {
            return false;
        };
        entry.version = Some(version);
        self.invalidator.mark_view(view);
        true
    }

    /// A retained subtree is being laid out: notified by `view`, its state
    /// at `id`, in the view being rendered.
    pub(crate) fn register_retained(&mut self, view: EntityId, id: &GlobalElementId) {
        let parent = self.rendered_entity_stack.last().copied();
        match self.retained_views.get_mut(&view) {
            Some(entry) => {
                entry.parent = parent;
                if entry.id != *id {
                    entry.id = id.clone();
                }
            }
            None => {
                self.retained_views.insert(
                    view,
                    RetainedEntry {
                        id: id.clone(),
                        parent,
                        version: None,
                    },
                );
            }
        }
    }

    /// Forget the retained subtrees whose states went since last asked.
    pub(crate) fn forget_gone_retained(&mut self) {
        let gone = std::mem::take(&mut *self.retained_gone.borrow_mut());
        for view in gone {
            self.retained_views.remove(&view);
        }
    }

    /// The retained subtrees around the one notified by `view`, outermost
    /// first, then itself: where the state of each is.
    pub(crate) fn retained_chain(&self, view: EntityId) -> Option<Vec<GlobalElementId>> {
        let mut chain = Vec::new();
        let mut next = Some(view);
        while let Some(entry) = next.and_then(|view| self.retained_views.get(&view)) {
            chain.push(entry.id.clone());
            next = entry.parent;
            if chain.len() > 64 {
                return None;
            }
        }
        chain.reverse();
        (!chain.is_empty()).then_some(chain)
    }

    /// The version the host said the retained subtree notified by `view`
    /// is at.
    pub(crate) fn retained_version(&self, view: EntityId) -> Option<u64> {
        self.retained_views
            .get(&view)
            .and_then(|entry| entry.version)
    }

    /// The retained subtrees around the one notified by `view` are dirty
    /// with it: a full frame builds them to reach it. (The dispatch tree
    /// says the same of a view in the frame; one left out of it is not
    /// there.)
    pub(crate) fn mark_retained_around_dirty(&mut self, view: EntityId) {
        let mut next = self
            .retained_views
            .get(&view)
            .and_then(|entry| entry.parent);
        while let Some(view) = next {
            let Some(entry) = self.retained_views.get(&view) else {
                break;
            };
            if !self.dirty_views.insert(view) {
                break;
            }
            next = entry.parent;
        }
    }

    /// Whether a partial frame is being drawn.
    #[inline]
    pub(crate) fn drawing_partial(&self) -> bool {
        self.partial.is_some()
    }

    /// Something asked for what a partial frame can't draw (while one is
    /// drawn; nothing otherwise). Whether one is being drawn.
    pub(crate) fn fail_partial(&mut self) -> bool {
        match &mut self.partial {
            Some(partial) => {
                partial.failed = true;
                true
            }
            None => false,
        }
    }

    /// Draw the frame as the one before with the retained subtrees notified
    /// by `notified` drawn again in it, when that is all that changed and
    /// each can be. `false`: nothing the next frame reads was changed, and
    /// the frame is to be drawn in full.
    pub(crate) fn draw_partial(&mut self, notified: &[EntityId], cx: &mut App) -> bool {
        let Some(hook) = self.partial_hook.clone() else {
            return false;
        };
        if self.refreshing
            || notified.is_empty()
            || cx.mode.skip_drawing()
            || self.prompt.is_some()
            || cx.active_drag.is_some()
            || self.tooltip_bounds.is_some()
            || self.a11y.is_active()
            || self.drawing_partial()
            || !self.in_place_stacks_empty()
            || !self.rendered_frame.scene.patchable()
        {
            return false;
        }
        // Every one notified is a retained subtree; the ones inside another
        // that was notified are drawn with it.
        let mut roots = SmallVec::<[EntityId; 4]>::new();
        for view in notified {
            let Some(entry) = self.retained_views.get(view) else {
                return false;
            };
            let mut around = entry.parent;
            let mut inside = false;
            while let Some(parent) = around {
                if notified.contains(&parent) {
                    inside = true;
                    break;
                }
                around = self
                    .retained_views
                    .get(&parent)
                    .and_then(|entry| entry.parent);
            }
            if !inside && !roots.contains(view) {
                roots.push(*view);
            }
        }
        if roots.is_empty() || roots.len() > MOST_ROOTS {
            return false;
        }

        hook(PartialFrame::Begin, self, cx);
        // The frame drawn last is the one being drawn.
        std::mem::swap(&mut self.rendered_frame, &mut self.next_frame);
        self.text_system.swap_layout_frames();
        self.partial = Some(Partial::default());
        let mut drawn = true;
        for view in roots {
            if !crate::elements::draw_in_place(view, self, cx) || self.partial_failed() {
                drawn = false;
                break;
            }
        }
        let partial = self.partial.take().unwrap_or_default();
        drawn &= !partial.failed;
        drawn &= self.next_frame.dispatch_tree.end_partial();
        self.invalidator.set_phase(DrawPhase::None);
        self.text_system.swap_layout_frames();
        std::mem::swap(&mut self.rendered_frame, &mut self.next_frame);
        // What the build asked the layout engine for is this frame's.
        self.layout_engine_mut().clear();
        if drawn {
            self.mouse_hit_test = self.rendered_frame.hit_test(self.mouse_position);
            cx.track_entities_accessed(self.handle, self.invalidator.clone(), &partial.accessed);
        }
        hook(PartialFrame::End { drawn }, self, cx);
        drawn
    }

    pub(super) fn partial_failed(&self) -> bool {
        self.partial.as_ref().is_some_and(|partial| partial.failed)
    }

    /// The subtrees a partial frame drew read `entities`.
    pub(crate) fn partial_accessed(&mut self, entities: impl IntoIterator<Item = EntityId>) {
        if let Some(partial) = &mut self.partial {
            partial.accessed.extend(entities);
        }
    }

    /// Whether nothing is being drawn: every stack a frame fills as it
    /// goes down the tree is empty, as between frames.
    fn in_place_stacks_empty(&self) -> bool {
        self.element_id_stack.is_empty()
            && self.text_style_stack.is_empty()
            && self.rendered_entity_stack.is_empty()
            && self.element_offset_stack.is_empty()
            && self.content_mask_stack.is_empty()
            && self.mask_ids.is_empty()
            && self.rem_size_override_stack.is_empty()
            && self.image_cache_stack.is_empty()
            && self.element_state_scopes.is_empty()
            && self.retained_nested.is_empty()
            && self.retained_recordings.is_empty()
            && self.retained_binding == 0
            && self.retained_detached == 0
    }

    /// Begin drawing a retained subtree where it is: the window is as it
    /// is when a full frame reaches the subtree's elements.
    pub(crate) fn enter_in_place(&mut self, under: &InPlace<'_>) {
        self.invalidator.set_phase(DrawPhase::Prepaint);
        for id in under.id.iter() {
            self.element_id_stack.push(ElementId::clone(id));
        }
        self.text_style_stack.extend_from_slice(under.text_styles);
        self.rendered_entity_stack.push(under.view);
        self.element_offset_stack.push(under.offset);
        self.content_mask_stack.push(under.mask.clone());
        self.rem_size_override_stack.push(under.rem_size);
        self.element_opacity = under.opacity;
    }

    /// The subtree is drawn, or given up: nothing is being drawn.
    pub(crate) fn leave_in_place(&mut self) {
        self.element_id_stack.clear();
        self.text_style_stack.clear();
        self.rendered_entity_stack.clear();
        self.element_offset_stack.clear();
        self.content_mask_stack.clear();
        self.mask_ids.clear();
        self.mask_free.clear();
        self.rem_size_override_stack.clear();
        self.element_opacity = 1.0;
        self.next_frame.scene.mask_id = 0;
    }

    /// Element states are looked up as in a prepaint.
    pub(crate) fn set_in_place_phase(&mut self) {
        self.invalidator.set_phase(DrawPhase::Prepaint);
    }

    /// Whether there is a state of type `S` for the element `id` where
    /// `with_element_state` would look for it.
    pub(crate) fn has_element_state<S: 'static>(&self, id: &GlobalElementId) -> bool {
        let key = (id.clone(), std::any::TypeId::of::<S>());
        match self.element_state_scopes.last() {
            Some(scope) => scope.next.contains_key(&key) || scope.prev.contains_key(&key),
            None => {
                self.next_frame.element_states.contains_key(&key)
                    || self.rendered_frame.element_states.contains_key(&key)
            }
        }
    }

    /// Where the lists that building a subtree's elements adds to end now
    /// (the element states it looks up, the text it measures): no range
    /// names what it adds, and `truncate_to_marks` takes it back.
    pub(crate) fn in_place_marks(&self) -> Marks {
        Marks {
            accessed_element_states: self.next_frame.accessed_element_states.len(),
            layouts: self.text_system.layout_index(),
        }
    }

    /// Take back what was added since `marks`.
    pub(crate) fn truncate_to_marks(&mut self, marks: &Marks) {
        self.next_frame
            .accessed_element_states
            .truncate(marks.accessed_element_states);
        self.text_system.truncate_used_layouts(&marks.layouts);
    }
}

/// The retained subtrees a window knows, by the entity each is notified by.
pub(crate) type RetainedViews = FxHashMap<EntityId, RetainedEntry>;
