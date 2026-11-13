//! The layout map as it was before it kept places and found what left at
//! the frame's end: what the new one must still answer for every frame
//! (`super::any_run_of_frames_paints_what_the_old_map_did`). It compared
//! every node on every frame: correct, and slow.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Bounds, Pixels, Point};

use crate::sim::LayoutNode;

/// Bounds recorded during the last paint, keyed by node id. Entries carry the
/// frame that painted them; lookups only see the latest frame, so nodes that
/// left the tree or scrolled out of a virtualized list are not reported at
/// stale positions.
#[derive(Clone, Default)]
pub(crate) struct OldMap(Rc<RefCell<LayoutState>>);

#[derive(Default)]
pub(crate) struct LayoutState {
    frame: u64,
    nodes: HashMap<String, Entry>,
    /// Retained subtrees (`retain.rs`), by group id: a node recorded inside
    /// one stays painted while the subtree's last drawing is reused, though
    /// nothing records it again.
    groups: HashMap<u64, Group>,
    /// Bumped whenever a node's bounds change, one is painted anew, or one
    /// is forgotten: what the accessibility tree checks before rebuilding.
    revision: u64,
}

struct Entry {
    bounds: Bounds<Pixels>,
    /// The frame that last recorded it.
    frame: u64,
    /// The retained subtree it was recorded in, if any.
    group: Option<u64>,
}

/// A retained subtree's frames, and where it sits. Its nodes are recorded
/// when it is drawn anew; when its drawing is copied elsewhere, or left out
/// (nothing of it shows), they are where they were recorded plus how far it
/// has moved since.
#[derive(Clone, Copy)]
struct Group {
    /// The retained subtree around it when it was last drawn.
    parent: Option<u64>,
    /// The last frame it was visited in (drawn anew, copied, or left out).
    touched: u64,
    /// The last frame it was drawn anew (its nodes recorded).
    built: u64,
    /// Its top left when it was last visited, and when it was last drawn anew.
    origin: Point<Pixels>,
    built_origin: Point<Pixels>,
    /// Where the subtree around it was when this one was last visited: this
    /// one has moved with it since, if it was not visited again.
    parent_origin: Point<Pixels>,
}

/// How often grouped entries no longer painted are dropped (they are never
/// reported meanwhile).
const PRUNE_EVERY: u64 = 64;

impl LayoutState {
    /// Whether retained subtree `group` was drawn in `frame`: drawn itself,
    /// or inside one that reused a drawing it was part of.
    fn group_live(&self, group: u64, frame: u64) -> bool {
        let Some(info) = self.groups.get(&group) else {
            return false;
        };
        if info.touched == frame {
            return true;
        }
        info.parent.is_some_and(|parent| {
            self.groups
                .get(&parent)
                .is_some_and(|outer| info.touched >= outer.built)
                && self.group_live(parent, frame)
        })
    }

    /// Where retained subtree `group` sits now: where it was last visited,
    /// moved along with the subtrees around it that were copied since.
    fn origin(&self, group: u64) -> Option<Point<Pixels>> {
        let info = self.groups.get(&group)?;
        if info.touched == self.frame {
            return Some(info.origin);
        }
        let carried = info
            .parent
            .and_then(|parent| self.origin(parent))
            .map(|parent| parent - info.parent_origin);
        Some(match carried {
            Some(carried) => info.origin + carried,
            None => info.origin,
        })
    }

    /// The bounds of `entry` now: as recorded, moved with its subtree.
    fn bounds_of(&self, entry: &Entry) -> Bounds<Pixels> {
        let moved = entry.group.and_then(|group| {
            let built = self.groups.get(&group)?.built_origin;
            Some(self.origin(group)? - built)
        });
        match moved {
            Some(moved) if moved != Point::default() => Bounds {
                origin: entry.bounds.origin + moved,
                size: entry.bounds.size,
            },
            _ => entry.bounds,
        }
    }

    /// Whether `entry` was painted in `frame`.
    fn painted_in(&self, entry: &Entry, frame: u64) -> bool {
        entry.frame == frame
            || entry.group.is_some_and(|group| {
                self.groups
                    .get(&group)
                    .is_some_and(|info| entry.frame >= info.built)
                    && self.group_live(group, frame)
            })
    }
}

impl OldMap {
    /// Start a frame: forget nodes the previous frame did not paint.
    pub(crate) fn begin_frame(&self) {
        let mut state = self.0.borrow_mut();
        state.frame += 1;
        let previous = state.frame - 1;
        let before = state.nodes.len();
        if state.frame.is_multiple_of(PRUNE_EVERY) {
            let dead: Vec<String> = state
                .nodes
                .iter()
                .filter(|(_, entry)| !state.painted_in(entry, previous))
                .map(|(id, _)| id.clone())
                .collect();
            for id in dead {
                state.nodes.remove(&id);
            }
            let dead: Vec<u64> = state
                .groups
                .keys()
                .copied()
                .filter(|group| !state.group_live(*group, previous))
                .collect();
            for group in dead {
                state.groups.remove(&group);
            }
        } else {
            state
                .nodes
                .retain(|_, entry| entry.group.is_some() || entry.frame >= previous);
        }
        if state.nodes.len() != before {
            state.revision += 1;
        }
    }

    /// Changes with any recorded bounds (see `LayoutState::revision`).
    pub(crate) fn revision(&self) -> u64 {
        self.0.borrow().revision
    }

    /// Record a node's bounds (`group`: the retained subtree it is drawn
    /// in); returns whether they changed since it was last painted (or it is
    /// newly painted).
    pub(crate) fn record(&self, id: &str, bounds: Bounds<Pixels>, group: Option<u64>) -> bool {
        let mut state = self.0.borrow_mut();
        let frame = state.frame;
        let changed = match state.nodes.get(id) {
            Some(entry) => {
                state.bounds_of(entry) != bounds
                    || !(entry.frame == frame || state.painted_in(entry, frame - 1))
            }
            None => true,
        };
        let entry = Entry {
            bounds,
            frame,
            group,
        };
        match state.nodes.get_mut(id) {
            Some(slot) => *slot = entry,
            None => {
                state.nodes.insert(id.to_string(), entry);
            }
        }
        if changed {
            state.revision += 1;
        }
        changed
    }

    /// A retained subtree was visited this frame inside `parent`, its top
    /// left at `origin`. `drew`: it is drawn anew, so its nodes are recorded
    /// again; otherwise its last drawing is copied there or left out, and
    /// its nodes are where they were recorded, moved as far as it has.
    pub(crate) fn touch_group(
        &self,
        group: u64,
        parent: Option<u64>,
        origin: Point<Pixels>,
        drew: bool,
    ) {
        let mut state = self.0.borrow_mut();
        let frame = state.frame;
        let moved = !drew && state.origin(group).is_some_and(|before| before != origin);
        let parent_origin = parent
            .and_then(|parent| state.origin(parent))
            .unwrap_or_default();
        let info = state.groups.entry(group).or_insert(Group {
            parent,
            touched: frame,
            built: frame,
            origin,
            built_origin: origin,
            parent_origin,
        });
        info.parent = parent;
        info.touched = frame;
        info.origin = origin;
        info.parent_origin = parent_origin;
        if drew {
            info.built = frame;
            info.built_origin = origin;
        }
        if moved {
            // Its nodes moved with it, though none is recorded again.
            state.revision += 1;
        }
    }

    /// Bounds painted in the latest frame.
    fn painted(&self) -> Vec<(String, Bounds<Pixels>)> {
        let state = self.0.borrow();
        state
            .nodes
            .iter()
            .filter(|(_, entry)| state.painted_in(entry, state.frame))
            .map(|(id, entry)| (id.clone(), state.bounds_of(entry)))
            .collect()
    }

    pub(crate) fn snapshot(&self) -> Vec<LayoutNode> {
        let mut nodes: Vec<LayoutNode> = self
            .painted()
            .into_iter()
            .map(|(id, bounds)| layout_node(id, bounds))
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        nodes
    }
}

fn layout_node(id: String, bounds: Bounds<Pixels>) -> LayoutNode {
    LayoutNode {
        id,
        x: f32::from(bounds.origin.x),
        y: f32::from(bounds.origin.y),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
    }
}
