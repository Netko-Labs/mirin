//! Retained subtrees: parts of the tree GPUI keeps across frames.
//!
//! Every frame used to build, lay out, prepaint and paint the whole tree, so
//! a frame cost what the tree's size did whatever changed. A view whose
//! subtree renders only from its own content (no renderer-side state such as
//! a field's text, focus, or a scroll offset) becomes a retained subtree
//! (`sumi::retained`, mirin's GPUI fork): it is built only when its content
//! differs from the previous tree (its `version`) or GPUI notified it (a
//! hover style changed), and otherwise keeps its layout and last frame's
//! drawing. Trees are compared as they arrive (`Boundaries::sync`), which
//! is linear in the tree but far cheaper than drawing it.
//!
//! A kept subtree that moved (it scrolled, or what is above it grew) has
//! its drawing copied to where it is now, and one nothing shows of (rows
//! scrolled out of a view) is not drawn at all (`Traits`); GPUI keeps its
//! drawing aside, up to a budget, and copies it back when it shows again.
//! Scroll views paint their content at whole device pixels (`drive.rs`,
//! `scroll_snap`), so a scrolled row lands a whole number of them away,
//! which is what a drawing can be copied by, at any scale factor.

use std::collections::HashMap;

use sumi::{
    div, prelude::*, AnyElement, App, Context, ElementId, Entity, EntityId, SharedString, Window,
};

mod counts;

pub(crate) use counts::take_counts;

use crate::patch::Document;
use crate::render::render_view;
use crate::tree::{NodeSpec, ViewProps};
use crate::window::RootView;

/// The fewest nodes a subtree has to be worth keeping: each kept subtree
/// costs some bookkeeping per frame it is drawn.
const MIN_NODES: usize = 4;

/// What notifications name a retained subtree by (GPUI's hover styles and
/// image loads notify the view they are drawn in): an entity per subtree.
pub(crate) struct Notified;

struct Boundary {
    /// Bumped whenever the subtree's content changes.
    version: u64,
    /// Its group in the layout map (`sim::LayoutMap::touch_group`).
    group: u64,
    entity: Entity<Notified>,
    /// Child indices from the root to it in the current tree.
    path: Vec<u32>,
    /// The sync that last found it (`Boundaries::syncs`), and only once.
    seen: u64,
    /// Whether it kept its length in a scroll view when its element was
    /// last made (`boundary`): half of the version the engine knows it by.
    keeps_length: bool,
    traits: Traits,
}

/// What a subtree holds that decides how its kept drawing may be used.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Traits {
    /// Renders from its content alone: it can be kept at all.
    pure: bool,
    /// No view inside watches its layout (`onLayout` hears of every move,
    /// which a drawing copied elsewhere would not tell it of).
    movable: bool,
    /// No view inside reports hovers (`onHover` must hear the pointer left
    /// though the view scrolled away from under it).
    skippable: bool,
}

impl Traits {
    fn and(self, other: Traits) -> Traits {
        Traits {
            pure: self.pure && other.pure,
            movable: self.movable && other.movable,
            skippable: self.skippable && other.skippable,
        }
    }
}

/// The retained subtrees of the current tree, by node id.
#[derive(Default)]
pub(crate) struct Boundaries {
    map: HashMap<String, Boundary>,
    next: u64,
    /// The tree generation the last sync saw (`patch::Document`).
    synced: u64,
    /// What each id'd view's subtree was at the last sync it was walked in
    /// (its traits, nodes): a patch walks only what changed.
    walks: HashMap<String, (Traits, usize)>,
    /// How many of those were left the last time the ones no longer in the
    /// tree went (`prune_walks`).
    walks_kept: usize,
    /// How many syncs there have been: what `Boundary::seen` counts in.
    syncs: u64,
    /// How many retained subtrees were left the last time the ones a patch
    /// removed from the tree went (`prune_removed`).
    kept: usize,
    /// The retained subtrees whose own content the sync under way found
    /// changed (`Synced::retained`).
    dirty: Vec<(EntityId, u64)>,
}

/// After a patch: whether anything in a view's subtree changed, and whether
/// the node itself did (`Document::subtree_generation`, `own_generation`).
#[derive(Clone, Copy)]
struct Changed<'a> {
    subtree: &'a dyn Fn(&str) -> bool,
    own: &'a dyn Fn(&str) -> bool,
}

/// The fewest walks kept before any that left the tree are looked for.
const WALKS_PRUNED_PAST: usize = 1024;

/// What a subtree is, as far as keeping it goes.
struct Walk {
    traits: Traits,
    nodes: usize,
    /// Equal to the subtree it was paired with in the previous tree.
    same: bool,
    /// After a patch: a node in it changed that no retained subtree in it
    /// is around (its own props, its children coming or going), or a
    /// retained subtree in it came, went or is kept differently: whatever
    /// is around it is to be built again.
    loose: bool,
}

/// What an update changed, as far as drawing it goes (`Boundaries::sync`).
#[derive(Default, Debug)]
pub(crate) struct Synced {
    /// Something changed outside every retained subtree, or the retained
    /// subtrees are not the ones they were: the root view is to be drawn.
    pub(crate) spine: bool,
    /// The retained subtrees whose own content changed (not that of one
    /// inside them): the entity each is notified by, and its new version.
    pub(crate) retained: Vec<(EntityId, u64)>,
}

impl Synced {
    /// Anything may have changed.
    pub(crate) fn everything() -> Self {
        Self {
            spine: true,
            retained: Vec::new(),
        }
    }

    /// Both this and `other` changed.
    pub(crate) fn and(&mut self, other: Synced) {
        self.spine |= other.spine;
        self.retained.extend(other.retained);
    }
}

impl Boundaries {
    /// Bring the retained subtrees in line with `doc` after an update:
    /// subtrees whose content changed get a new version, new ones are added,
    /// and ones no longer in the tree (or whose id is not unique) are dropped.
    /// After a patch (`by_generation`) a subtree changed when its subtree
    /// generation is newer than the last sync; after a whole tree it is
    /// compared with the one it replaced (`old`; none: all changed).
    ///
    /// After a patch a retained subtree gets a new version only when its
    /// own content changed, not when that of one inside it did: the answer
    /// names those, and the engine draws the ones around them when it
    /// draws the whole frame (a notified retained subtree marks them), and
    /// leaves them alone when it draws only what changed (a partial frame).
    pub(crate) fn sync(
        &mut self,
        old: Option<&NodeSpec>,
        doc: &Document,
        by_generation: bool,
        cx: &mut App,
    ) -> Synced {
        if !enabled() {
            return Synced::everything();
        }
        self.syncs += 1;
        self.dirty.clear();
        let mut path = Vec::new();
        let mut duplicates = Vec::new();
        let synced = self.synced;
        let changed = |id: &str| doc.subtree_generation(id) > synced;
        let own = |id: &str| doc.own_generation(id) > synced;
        let changed: Option<Changed<'_>> = by_generation.then_some(Changed {
            subtree: &changed,
            own: &own,
        });
        if !by_generation {
            self.walks.clear();
        }
        let walked = self.walk(doc, old, changed, &mut path, &mut duplicates, cx);
        self.synced = doc.generation();
        if by_generation {
            // After a patch, a subtree that didn't change was not walked:
            // the retained subtrees in it stay. One that was walked and is
            // no longer kept went as it was walked (`walk`); what is left
            // is the ones the patch took out of the tree.
            self.prune_walks(doc);
            self.prune_removed(doc);
        } else {
            let syncs = self.syncs;
            self.map.retain(|_, boundary| boundary.seen == syncs);
            self.kept = self.map.len();
        }
        let spine = !by_generation || walked.loose || !duplicates.is_empty();
        for id in duplicates {
            self.map.remove(&id);
        }
        Synced {
            spine,
            retained: std::mem::take(&mut self.dirty),
        }
    }

    /// A patch walks only what it changed, so the retained subtrees of the
    /// views it removed are not come across. Looking for them among all of
    /// them after every patch cost a patch what the window holds (2,601 on
    /// the stress app: most of an apply). Nothing asks for one by an id
    /// that is not in the tree, and an id that comes back is walked and
    /// given a new version, so they are let go as `prune_walks` lets walks
    /// go: once there are twice as many as after the last time.
    fn prune_removed(&mut self, doc: &Document) {
        if self.map.len() <= 2 * self.kept.max(WALKS_PRUNED_PAST) {
            return;
        }
        self.map.retain(|id, _| doc.contains(id));
        self.kept = self.map.len();
    }

    /// A patch walks only what it changed, so the walks of views it removed
    /// would stay for as long as the window does (each new view's id added
    /// one for good). They go once there are twice as many walks as after
    /// the last time: a patch costs no more for it, amortized.
    fn prune_walks(&mut self, doc: &Document) {
        if self.walks.len() <= 2 * self.walks_kept.max(WALKS_PRUNED_PAST) {
            return;
        }
        self.walks.retain(|id, _| doc.contains(id));
        self.walks_kept = self.walks.len();
    }

    fn walk(
        &mut self,
        node: &NodeSpec,
        old: Option<&NodeSpec>,
        changed: Option<Changed<'_>>,
        path: &mut Vec<u32>,
        duplicates: &mut Vec<String>,
        cx: &mut App,
    ) -> Walk {
        let NodeSpec::View { props, children } = node else {
            return Walk {
                traits: Traits {
                    pure: !matches!(node, NodeSpec::Input { .. }),
                    movable: true,
                    skippable: true,
                },
                nodes: 1,
                same: old == Some(node),
                // A leaf a patch changed says so by its id; one without an
                // id changes only with the view it is in.
                loose: changed
                    .is_some_and(|changed| node.key().is_some_and(|id| (changed.own)(id))),
            };
        };
        let old_view = match old {
            Some(NodeSpec::View { props, children }) => Some((props, children)),
            _ => None,
        };
        let by_index = old_view.is_some_and(|(_, old_children)| {
            old_children.len() == children.len()
                && old_children
                    .iter()
                    .zip(children)
                    .all(|(old, new)| crate::render::node_id(old) == crate::render::node_id(new))
        });
        let by_id: HashMap<String, &NodeSpec> = match old_view {
            Some((_, old_children)) if !by_index => old_children
                .iter()
                .filter_map(|child| crate::render::node_id(child).map(|id| (id, child)))
                .collect(),
            _ => HashMap::new(),
        };
        let id = props.id.as_deref();
        if let Some((id, changed)) = id.zip(changed) {
            if !(changed.subtree)(id) {
                if let Some(&(traits, nodes)) = self.walks.get(id) {
                    // Unchanged since the last sync: as it was then.
                    return Walk {
                        traits,
                        nodes,
                        same: true,
                        loose: false,
                    };
                }
            }
        }
        let mut walk = Walk {
            traits: Traits {
                pure: pure_view(props, children),
                movable: !props.on_layout,
                skippable: !props.on_hover,
            },
            nodes: 1,
            same: by_index && old_view.is_some_and(|(old_props, _)| old_props == props),
            // A view without an id is walked whenever what it is in is:
            // whether it changed is not known, so it is taken to have.
            loose: changed.is_some_and(|changed| id.is_none_or(|id| (changed.own)(id))),
        };
        for (index, child) in children.iter().enumerate() {
            let paired = match old_view {
                Some((_, old_children)) if by_index => old_children.get(index),
                Some(_) => crate::render::node_id(child).and_then(|id| by_id.get(&id).copied()),
                None => None,
            };
            path.push(index as u32);
            let child_walk = self.walk(child, paired, changed, path, duplicates, cx);
            path.pop();
            walk.traits = walk.traits.and(child_walk.traits);
            walk.nodes += child_walk.nodes;
            walk.same &= child_walk.same;
            walk.loose |= child_walk.loose;
        }
        if let Some(id) = id {
            match self.walks.get_mut(id) {
                Some(entry) => *entry = (walk.traits, walk.nodes),
                None => {
                    self.walks.insert(id.to_owned(), (walk.traits, walk.nodes));
                }
            }
        }
        match id {
            Some(id) if walk.traits.pure && walk.nodes >= MIN_NODES => {
                // After a patch, its own content changed when something in
                // it did that no retained subtree inside it is around.
                let same = match changed {
                    Some(_) => !walk.loose,
                    None => walk.same,
                };
                // What changed in it is its own to draw; that it is newly
                // kept, or kept differently, is for what is around it.
                walk.loose = self.keep(id, same, walk.traits, path, duplicates, cx);
            }
            // Walked and not kept (it changed into something that is not
            // kept): what was kept for it before goes. One found twice in
            // this sync stays until the sync ends (`duplicates`).
            Some(id) => {
                let syncs = self.syncs;
                if self.map.get(id).is_some_and(|kept| kept.seen != syncs) {
                    self.map.remove(id);
                    walk.loose = true;
                }
            }
            None => {}
        }
        walk
    }

    /// Keep the view `id` as a retained subtree, at a new version unless
    /// its content is the `same`. Whether it is newly kept, or may be drawn
    /// differently from before (`Traits`): what is around it makes its
    /// element and is to be built again.
    fn keep(
        &mut self,
        id: &str,
        same: bool,
        traits: Traits,
        path: &[u32],
        duplicates: &mut Vec<String>,
        cx: &mut App,
    ) -> bool {
        if let Some(boundary) = self.map.get_mut(id) {
            if boundary.seen == self.syncs {
                // Two nodes with one id: neither can be found by it.
                duplicates.push(id.to_owned());
                return true;
            }
            boundary.seen = self.syncs;
            let kept_differently = boundary.traits != traits;
            boundary.traits = traits;
            path.clone_into(&mut boundary.path);
            if !same {
                self.next += 1;
                boundary.version = self.next;
                self.dirty.push((
                    boundary.entity.entity_id(),
                    boundary.version * 2 + u64::from(boundary.keeps_length),
                ));
            }
            return kept_differently;
        }
        self.next += 1;
        let boundary = Boundary {
            version: self.next,
            group: self.next,
            entity: cx.new(|_| Notified),
            path: path.to_vec(),
            seen: self.syncs,
            keeps_length: false,
            traits,
        };
        self.map.insert(id.to_owned(), boundary);
        true
    }

    fn get(&self, id: &str) -> Option<&Boundary> {
        self.map.get(id)
    }

    /// Start counting what a frame draws (`counts`) from nothing.
    pub(crate) fn forget_counts() {
        counts::take_counts();
    }

    /// The layout group of the retained subtree view `id` is the root of,
    /// when it is one: what the accessibility tree places its nodes in.
    pub(crate) fn group(&self, id: &str) -> Option<u64> {
        self.map.get(id).map(|boundary| boundary.group)
    }
}

/// Whether subtrees are kept (`MIRIN_METAL_RETAIN=0` draws every frame
/// whole, as before: for comparing the two).
pub(crate) fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MIRIN_METAL_RETAIN").map_or(true, |value| value != "0"))
}

/// Whether a view renders from its own props alone (its children are
/// checked separately): nothing it draws reads renderer-side state that
/// changes without its content changing or GPUI notifying it.
fn pure_view(props: &ViewProps, children: &[NodeSpec]) -> bool {
    !(props.focusable
        || props.focus_group
        || props.focus_trap
        || props.selects_on_focus
        || props.focus_ring_color.is_some()
        || props.on_window_key
        || props.on_key_down
        || props.scroll
        || props.scroll_x
        || props.height_transition_ms.is_some()
        || props.drag_files.is_some()
        || props.on_drop
        || crate::list::virtualizes(props, children))
}

/// The node at `path` from `root`.
fn node_at<'a>(root: &'a NodeSpec, path: &[u32]) -> Option<&'a NodeSpec> {
    path.iter().try_fold(root, |node, &index| match node {
        NodeSpec::View { children, .. } => children.get(index as usize),
        _ => None,
    })
}

/// A retained subtree for the view `props`, when it is one.
pub(crate) fn boundary(
    props: &ViewProps,
    view: &mut RootView,
    cx: &mut Context<RootView>,
) -> Option<AnyElement> {
    let id = props.id.as_deref()?;
    let boundary = view.boundaries.map.get_mut(id)?;
    // Whether it keeps its length in a scroll view is the one thing its
    // parent decides about how it renders (render.rs); it is part of its version.
    let keeps_length = std::mem::take(&mut view.keeps_length);
    boundary.keeps_length = keeps_length;
    let version = boundary.version * 2 + u64::from(keeps_length);
    let (group, parent) = (boundary.group, view.group);
    let traits = boundary.traits;
    let notified: EntityId = boundary.entity.entity_id();
    let root = cx.entity();
    let node_id: SharedString = id.to_owned().into();
    let layout = view.layout.clone();
    let element = sumi::retained(
        ElementId::Name(node_id.clone()),
        notified,
        version,
        move |window: &mut Window, cx: &mut App| {
            root.update(cx, |view, cx| {
                build(view, &node_id, keeps_length, group, window, cx)
            })
        },
    )
    .movable(traits.movable)
    .skippable(traits.skippable);
    // Of its root alone: what is inside is laid out by taffy, which says
    // whether any of it changed.
    let element = element
        .stretchable(crate::render::draws_nothing_of_its_size(props))
        .on_prepaint(move |draw, bounds, _window, _cx| {
            layout.touch_group(group, parent, bounds.origin, draw.drew());
            counts::count(draw);
        });
    Some(element.into_any_element())
}

/// Build a retained subtree's elements (GPUI asks when it changed).
fn build(
    view: &mut RootView,
    id: &str,
    keeps_length: bool,
    group: u64,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
    // Shared only while it is built: a tree held past the frame makes the
    // next patch copy it whole.
    let tree = std::rc::Rc::clone(view.tree.tree());
    // Found by id after a patch (paths of unchanged subtrees may be stale);
    // after a whole tree by the path its sync recorded.
    let node = view.tree.find_in(&tree, id).or_else(|| {
        view.boundaries
            .get(id)
            .and_then(|boundary| node_at(&tree, &boundary.path))
    });
    let Some(NodeSpec::View { props, children }) = node else {
        return div().into_any_element();
    };
    let parent = view.group.replace(group);
    view.keeps_length = keeps_length;
    let element = render_view(props, children, view, window, cx);
    view.group = parent;
    element
}

#[cfg(test)]
mod gpui_tests;
#[cfg(test)]
mod partial_tests;
#[cfg(test)]
mod scene_tests;
#[cfg(test)]
mod tests;
