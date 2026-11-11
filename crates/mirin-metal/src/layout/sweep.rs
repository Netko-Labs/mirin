//! What a frame no longer draws: a group drawn anew says again everything
//! in it, so what it drew before and not now has left, with all that was
//! in it. Nothing is dropped yet: a drawing reused again brings it back.

use super::state::{Drawn, LayoutState};

impl LayoutState {
    /// The frame's prepaint is over: what was drawn anew said again what is
    /// in it, and what it did not say again has left.
    pub(super) fn end_frame(&mut self) {
        if self.ended == self.frame {
            return;
        }
        self.ended = self.frame;
        let frame = self.frame;
        let top = std::mem::take(&mut self.top);
        self.top = self.leave(top, None);
        for group in std::mem::take(&mut self.built) {
            let Some(info) = self
                .groups
                .get_mut(&group)
                .filter(|info| info.swept != frame)
            else {
                continue;
            };
            info.swept = frame;
            let drawn = std::mem::take(&mut info.drawn);
            let drawn = self.leave(drawn, Some(group));
            if let Some(info) = self.groups.get_mut(&group) {
                info.drawn = drawn;
            }
        }
    }

    /// `around` (a group, or the window outside every group) was drawn anew
    /// this frame: what it drew before and not now is no longer drawn. Gives
    /// back what it draws now.
    fn leave(&mut self, mut drawn: Drawn, around: Option<u64>) -> Drawn {
        let frame = self.frame;
        for id in &drawn.nodes {
            let left = self
                .nodes
                .get_mut(id)
                .filter(|entry| !entry.dead && entry.group == around && entry.frame < frame);
            if let Some(entry) = left {
                entry.dead = true;
                self.note_node(id);
            }
        }
        for &group in &drawn.groups {
            let left = self
                .groups
                .get(&group)
                .is_some_and(|info| !info.dead && info.parent == around && info.touched < frame);
            if left {
                self.kill(group);
            }
        }
        std::mem::swap(&mut drawn.nodes, &mut drawn.now_nodes);
        std::mem::swap(&mut drawn.groups, &mut drawn.now_groups);
        drawn.now_nodes.clear();
        drawn.now_groups.clear();
        drawn
    }

    /// `group` is no longer drawn, nor is anything in it.
    fn kill(&mut self, group: u64) {
        let frame = self.frame;
        let Some(info) = self.groups.get_mut(&group) else {
            return;
        };
        info.dead = true;
        let drawn = std::mem::take(&mut info.drawn);
        self.note_group(group);
        for id in &drawn.nodes {
            let inside = self
                .nodes
                .get_mut(id)
                .filter(|entry| !entry.dead && entry.group == Some(group));
            if let Some(entry) = inside {
                entry.dead = true;
                self.note_node(id);
            }
        }
        for &inner in &drawn.groups {
            let inside = self.groups.get(&inner).is_some_and(|info| {
                !info.dead && info.parent == Some(group) && info.touched < frame
            });
            if inside {
                self.kill(inner);
            }
        }
        if let Some(info) = self.groups.get_mut(&group) {
            info.drawn = drawn;
        }
    }

    /// `group`'s last drawing is used again after a time it was not drawn:
    /// what it drew then is drawn again.
    pub(super) fn revive(&mut self, group: u64) {
        let Some(info) = self.groups.get_mut(&group) else {
            return;
        };
        let drawn = std::mem::take(&mut info.drawn);
        for id in &drawn.nodes {
            let inside = self
                .nodes
                .get_mut(id)
                .filter(|entry| entry.dead && entry.group == Some(group));
            if let Some(entry) = inside {
                entry.dead = false;
                self.note_node(id);
            }
        }
        for &inner in &drawn.groups {
            let inside = self
                .groups
                .get_mut(&inner)
                .filter(|info| info.dead && info.parent == Some(group));
            if let Some(info) = inside {
                info.dead = false;
                self.note_group(inner);
                self.revive(inner);
            }
        }
        if let Some(info) = self.groups.get_mut(&group) {
            info.drawn = drawn;
        }
    }
}
