//! What the layout map keeps: nodes as recorded, groups as visited, and
//! which of them a frame no longer draws.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Bounds, Pixels, Point};

use super::{Changes, Placed};

/// How often what is no longer drawn is dropped for good (it is never
/// reported meanwhile).
const PRUNE_EVERY: u64 = 64;

#[derive(Default)]
pub(super) struct LayoutState {
    pub(super) frame: u64,
    /// The last frame whose leavers were found (`end_frame`).
    pub(super) ended: u64,
    pub(super) nodes: HashMap<Rc<str>, Entry>,
    pub(super) groups: HashMap<u64, Group>,
    /// What is drawn outside every group: said again every frame.
    pub(super) top: Drawn,
    /// The groups drawn anew this frame.
    pub(super) built: Vec<u64>,
    pub(super) revision: u64,
    /// What changed since it was last taken, while someone takes it.
    pub(super) changes: Option<Changes>,
}

pub(super) struct Entry {
    /// As recorded, in the window.
    bounds: Bounds<Pixels>,
    /// Where its group's top left was then (the window's: zero).
    at: Point<Pixels>,
    /// What draws it.
    pub(super) group: Option<u64>,
    /// The frame that last recorded it.
    pub(super) frame: u64,
    /// No longer drawn; kept until pruned, since its group's drawing may be
    /// reused again.
    pub(super) dead: bool,
}

impl Entry {
    /// Where it sits in its group. Exact: the differences of what was
    /// recorded, in f64.
    pub(super) fn placed(&self) -> Placed {
        let x = f64::from(self.bounds.origin.x) - f64::from(self.at.x);
        let y = f64::from(self.bounds.origin.y) - f64::from(self.at.y);
        let width = f64::from(self.bounds.size.width);
        let height = f64::from(self.bounds.size.height);
        Placed {
            rect: [x, y, x + width, y + height],
            group: self.group,
        }
    }
}

/// What a group (or the window outside every group) drew when it was last
/// drawn anew, and what it has drawn so far in the frame it is drawn in.
#[derive(Default)]
pub(super) struct Drawn {
    pub(super) nodes: Vec<Rc<str>>,
    pub(super) groups: Vec<u64>,
    pub(super) now_nodes: Vec<Rc<str>>,
    pub(super) now_groups: Vec<u64>,
}

impl Drawn {
    /// Where a node drawn in it is noted: with what it says this frame,
    /// while it is drawn anew. (Nothing else draws in it; what did all the
    /// same goes when it does.)
    fn nodes_said(&mut self, anew: bool) -> &mut Vec<Rc<str>> {
        if anew {
            &mut self.now_nodes
        } else {
            &mut self.nodes
        }
    }

    /// The same for a group visited in it.
    fn groups_said(&mut self, anew: bool) -> &mut Vec<u64> {
        if anew {
            &mut self.now_groups
        } else {
            &mut self.groups
        }
    }
}

pub(super) struct Group {
    /// The group around it when it was last visited.
    pub(super) parent: Option<u64>,
    /// The last frame it was visited in (drawn anew, copied, or left out).
    pub(super) touched: u64,
    /// The last frame it was drawn anew in (its nodes recorded).
    built: u64,
    /// Its top left when it was last visited, and that of the group around
    /// it then: it has moved with that group since, if not visited again.
    origin: Point<Pixels>,
    parent_origin: Point<Pixels>,
    pub(super) drawn: Drawn,
    /// The frame its leavers were last found in.
    pub(super) swept: u64,
    /// No longer drawn (see `Entry::dead`).
    pub(super) dead: bool,
}

impl Group {
    /// Where its top left is from that of the group around it.
    pub(super) fn offset(&self) -> (f64, f64) {
        (
            f64::from(self.origin.x) - f64::from(self.parent_origin.x),
            f64::from(self.origin.y) - f64::from(self.parent_origin.y),
        )
    }
}

impl LayoutState {
    pub(super) fn begin_frame(&mut self) {
        self.end_frame();
        self.frame += 1;
        if self.frame.is_multiple_of(PRUNE_EVERY) {
            self.nodes.retain(|_, entry| !entry.dead);
            self.groups.retain(|_, group| !group.dead);
        }
    }

    fn live_group(&self, group: u64) -> bool {
        self.groups.get(&group).is_some_and(|info| !info.dead)
    }

    /// Where `group` has its top left now: where it was last visited, moved
    /// along with the groups around it that were visited since.
    pub(super) fn origin(&self, group: u64) -> Option<Point<Pixels>> {
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

    /// The bounds of `entry` now: as recorded, moved with its group.
    pub(super) fn bounds_of(&self, entry: &Entry) -> Bounds<Pixels> {
        let moved = entry
            .group
            .and_then(|group| self.origin(group))
            .map(|origin| origin - entry.at);
        match moved {
            Some(moved) if moved != Point::default() => Bounds {
                origin: entry.bounds.origin + moved,
                size: entry.bounds.size,
            },
            _ => entry.bounds,
        }
    }

    pub(super) fn note_node(&mut self, id: &Rc<str>) {
        self.revision += 1;
        if let Some(changes) = &mut self.changes {
            changes.nodes.push(Rc::clone(id));
        }
    }

    pub(super) fn note_group(&mut self, group: u64) {
        self.revision += 1;
        if let Some(changes) = &mut self.changes {
            changes.groups.push(group);
        }
    }

    pub(super) fn record(&mut self, id: &str, bounds: Bounds<Pixels>, group: Option<u64>) -> bool {
        // A group that was never visited draws nothing.
        let group = group.filter(|group| self.live_group(*group));
        let at = group
            .and_then(|group| self.origin(group))
            .unwrap_or_default();
        let frame = self.frame;
        let entry = Entry {
            bounds,
            at,
            group,
            frame,
            dead: false,
        };
        let (key, repainted, in_place) = match self.nodes.get_key_value(id) {
            Some((key, old)) => (
                Rc::clone(key),
                !old.dead && old.bounds == bounds,
                !old.dead && old.placed() == entry.placed(),
            ),
            None => (Rc::from(id), false, false),
        };
        self.nodes.insert(Rc::clone(&key), entry);
        if !in_place {
            self.note_node(&key);
        }
        match group.and_then(|group| self.groups.get_mut(&group)) {
            Some(info) => info.drawn.nodes_said(info.built == frame).push(key),
            None => self.top.now_nodes.push(key),
        }
        !repainted
    }

    pub(super) fn touch(
        &mut self,
        group: u64,
        parent: Option<u64>,
        origin: Point<Pixels>,
        drew: bool,
    ) {
        let frame = self.frame;
        let parent = parent.filter(|parent| *parent != group && self.live_group(*parent));
        let parent_origin = parent
            .and_then(|parent| self.origin(parent))
            .unwrap_or_default();
        let before = self
            .groups
            .get(&group)
            .map(|info| (info.dead, info.parent, info.offset()));
        let info = self.groups.entry(group).or_insert_with(|| Group {
            parent,
            touched: frame,
            built: 0,
            origin,
            parent_origin,
            drawn: Drawn::default(),
            swept: 0,
            dead: false,
        });
        info.parent = parent;
        info.touched = frame;
        info.origin = origin;
        info.parent_origin = parent_origin;
        info.dead = false;
        let in_place = before == Some((false, parent, info.offset()));
        if drew {
            info.built = frame;
            info.drawn.now_nodes.clear();
            info.drawn.now_groups.clear();
            self.built.push(group);
        }
        match parent.and_then(|parent| self.groups.get_mut(&parent)) {
            Some(info) => info.drawn.groups_said(info.built == frame).push(group),
            None => self.top.now_groups.push(group),
        }
        if !in_place {
            self.note_group(group);
        }
        if !drew && before.is_some_and(|(dead, ..)| dead) {
            // Its last drawing is used again: what it drew is back with it.
            self.revive(group);
        }
    }
}
