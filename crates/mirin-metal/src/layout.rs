//! Where the last paint put every id'd node (`LayoutMap`), and what moved as
//! one.
//!
//! Views record their children's bounds as they are prepainted. What draws
//! them is a *group*: a retained subtree (`retain.rs`), which records its
//! nodes only when it is drawn anew and otherwise carries them along as its
//! drawing is copied elsewhere or left out, or a scroll view's content
//! (`scroll.rs`), which moves as one with every scroll. A node is kept as
//! recorded and where its group then was, so it is where its group is now,
//! plus where it sat in it; a group is kept where it is in the group around
//! it.
//!
//! That is also what the accessibility tree is made of (`access/`): a node's
//! place in its group and a group's place in the one around it change only
//! when something is laid out differently, not when it scrolls or what is
//! above it grows, and `Changes` names exactly the nodes and groups that did.
//!
//! What a frame no longer draws is found when the frame ends (`end_frame`):
//! a group drawn anew says again everything in it, and what it does not say
//! again has left. It is kept a while unseen, because a drawing reused again
//! brings its nodes back with it.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{Bounds, Pixels, Point};

use crate::sim::LayoutNode;

mod scroll;
mod state;
mod sweep;
#[cfg(test)]
mod tests;

pub(crate) use scroll::{scroll_frame, scroll_group};
use state::{Entry, LayoutState};

/// Bounds recorded during the last paint, keyed by node id.
#[derive(Clone, Default)]
pub(crate) struct LayoutMap(Rc<RefCell<LayoutState>>);

/// The nodes and groups that are somewhere else in what draws them (or are
/// drawn now, or no longer) since the changes were last taken.
#[derive(Default)]
pub(crate) struct Changes {
    pub(crate) nodes: Vec<Rc<str>>,
    pub(crate) groups: Vec<u64>,
}

impl Changes {
    pub(crate) fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.groups.is_empty()
    }
}

/// Where a node sits in the group that draws it: left, top, right, bottom
/// from the group's top left (the window's when no group draws it).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Placed {
    pub(crate) rect: [f64; 4],
    pub(crate) group: Option<u64>,
}

/// Where a group's top left is from that of the group around it (the
/// window's when it is in none).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Frame {
    pub(crate) offset: (f64, f64),
    pub(crate) parent: Option<u64>,
}

impl LayoutMap {
    /// Start a frame (ending the last one, if nothing did).
    pub(crate) fn begin_frame(&self) {
        self.0.borrow_mut().begin_frame();
    }

    /// The frame's prepaint is over: what it did not draw has left.
    pub(crate) fn end_frame(&self) {
        self.0.borrow_mut().end_frame();
    }

    /// Changes whenever a node's place in its group or a group's place in
    /// the one around it does, or either comes or goes: what the
    /// accessibility tree checks before it looks at anything.
    pub(crate) fn revision(&self) -> u64 {
        self.0.borrow().revision
    }

    /// Record a node's bounds (`group`: what draws it, when a group does);
    /// returns whether they changed since it was last recorded (or it is
    /// newly painted).
    pub(crate) fn record(&self, id: &str, bounds: Bounds<Pixels>, group: Option<u64>) -> bool {
        self.0.borrow_mut().record(id, bounds, group)
    }

    /// A group was visited this frame inside `parent`, its top left at
    /// `origin`. `drew`: it is drawn anew, so its nodes are recorded again;
    /// otherwise its last drawing is copied there or left out, and its nodes
    /// are where they were recorded, moved as far as it has.
    pub(crate) fn touch_group(
        &self,
        group: u64,
        parent: Option<u64>,
        origin: Point<Pixels>,
        drew: bool,
    ) {
        self.0.borrow_mut().touch(group, parent, origin, drew);
    }

    /// Bounds painted in the latest frame.
    fn painted(&self) -> Vec<(String, Bounds<Pixels>)> {
        let state = self.0.borrow();
        let painted = state.nodes.iter().filter(|(_, entry)| !entry.dead);
        painted
            .map(|(id, entry)| (id.to_string(), state.bounds_of(entry)))
            .collect()
    }

    /// The smallest painted node containing `point`.
    pub(crate) fn innermost_at(&self, point: Point<Pixels>) -> Option<String> {
        self.painted()
            .into_iter()
            .filter(|(_, bounds)| bounds.contains(&point))
            .min_by(|(_, a), (_, b)| {
                let area = |b: &Bounds<Pixels>| f32::from(b.size.width) * f32::from(b.size.height);
                area(a).total_cmp(&area(b))
            })
            .map(|(id, _)| id)
    }

    /// A node's bounds in the window, if the last frame painted it.
    pub(crate) fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        let state = self.0.borrow();
        let entry = state.nodes.get(id).filter(|entry| !entry.dead)?;
        Some(state.bounds_of(entry))
    }

    pub(crate) fn node(&self, id: &str) -> Option<LayoutNode> {
        self.bounds(id)
            .map(|bounds| layout_node(id.to_string(), bounds))
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

    /// Where a painted node sits in what draws it.
    pub(crate) fn placed(&self, id: &str) -> Option<Placed> {
        let state = self.0.borrow();
        state
            .nodes
            .get(id)
            .filter(|entry| !entry.dead)
            .map(Entry::placed)
    }

    /// Where a group that is drawn sits in the one around it.
    pub(crate) fn frame(&self, group: u64) -> Option<Frame> {
        let state = self.0.borrow();
        let info = state.groups.get(&group).filter(|info| !info.dead)?;
        Some(Frame {
            offset: info.offset(),
            parent: info.parent,
        })
    }

    /// Where a group that is drawn has its top left in the window.
    pub(crate) fn origin(&self, group: u64) -> Option<(f64, f64)> {
        let state = self.0.borrow();
        state.groups.get(&group).filter(|info| !info.dead)?;
        let origin = state.origin(group)?;
        Some((f64::from(origin.x), f64::from(origin.y)))
    }

    /// What changed since this was last asked, and keep noting it; None
    /// when nothing was being noted (anything may have changed).
    pub(crate) fn take_changes(&self) -> Option<Changes> {
        self.0.borrow_mut().changes.replace(Changes::default())
    }

    /// Nobody asks for the changes any more: none are noted.
    pub(crate) fn drop_changes(&self) {
        self.0.borrow_mut().changes = None;
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
