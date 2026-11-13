//! What a change to the tree may concern among the renderer's own state
//! (focus order, fields, key views, scroll views, height transitions,
//! virtualized lists), so a patch brings only that in line
//! (`RootView::tree_changed`) instead of walking the whole tree for each.

use std::ops::{BitOr, BitOrAssign};

use crate::tree::NodeSpec;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Touched(u8);

impl Touched {
    pub(crate) const NONE: Self = Self(0);
    /// A field came, went, or changed (`RootView::sync_inputs`).
    pub(crate) const INPUTS: Self = Self(1);
    /// A view taking raw keys came or went.
    pub(crate) const KEYS: Self = Self(1 << 1);
    /// The Tab order may differ: a field, a focusable view, a group, a
    /// trap, a window-key view, or a ring color came, went, moved or changed.
    pub(crate) const FOCUS: Self = Self(1 << 2);
    /// A scroll view came, went, or changed.
    pub(crate) const SCROLLS: Self = Self(1 << 3);
    /// A view with a height transition came, went, or changed.
    pub(crate) const HEIGHTS: Self = Self(1 << 4);
    /// A virtualized list may have come or gone: children came or went near
    /// a scroll view, or a scroll view changed. (A change inside a list's
    /// rows is found by its generation.)
    pub(crate) const LISTS: Self = Self(1 << 5);
    pub(crate) const ALL: Self = Self(u8::MAX);

    pub(crate) fn contains(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }

    /// What the node itself concerns (not its children).
    pub(crate) fn of_node(node: &NodeSpec) -> Self {
        match node {
            NodeSpec::View { props, .. } => {
                let mut touched = Self::NONE;
                if props.on_key_down {
                    touched |= Self::KEYS | Self::FOCUS;
                }
                if props.focusable
                    || props.focus_group
                    || props.focus_trap
                    || props.on_window_key
                    || props.focus_ring_color.is_some()
                {
                    touched |= Self::FOCUS;
                }
                if props.scroll || props.scroll_x {
                    touched |= Self::SCROLLS | Self::LISTS;
                }
                if props.height_transition_ms.is_some() {
                    touched |= Self::HEIGHTS;
                }
                touched
            }
            NodeSpec::Input { .. } => Self::INPUTS | Self::FOCUS,
            NodeSpec::Text { .. } | NodeSpec::Svg { .. } | NodeSpec::Image { .. } => Self::NONE,
        }
    }

    /// What the node and everything under it concerns.
    pub(crate) fn of_subtree(node: &NodeSpec) -> Self {
        let mut touched = Self::of_node(node);
        if let NodeSpec::View { children, .. } = node {
            for child in children {
                touched |= Self::of_subtree(child);
            }
        }
        touched
    }
}

impl BitOr for Touched {
    type Output = Self;

    fn bitor(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

impl BitOrAssign for Touched {
    fn bitor_assign(&mut self, other: Self) {
        self.0 |= other.0;
    }
}
