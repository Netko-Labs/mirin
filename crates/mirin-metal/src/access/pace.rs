//! How often the accessibility tree is built again (`Accessibility::refresh`).
//!
//! A new tree, focus, window state or title is built at once: a screen
//! reader speaks it. Bounds that moved alone (a scroll, a resize) change on
//! every frame, and building the whole tree for each one cost a host about
//! half again its CPU while scrolling a long list, and the compositor as
//! much again, since Dashi keeps AT-SPI on for its agents. A screen reader
//! needs where things are, not every step of the way there: moved bounds are
//! published at most every `LAYOUT_EVERY`, and once more after the movement
//! stops (the caller repaints after the wait `Step::Defer` names). With no
//! screen reader listening they wait for the next tree that changes; one
//! that starts later gets the last tree built, then fresh bounds.

use std::time::Duration;

/// The least time between two publishes of bounds that moved alone.
pub(crate) const LAYOUT_EVERY: Duration = Duration::from_millis(250);

/// What changed since the tree was last built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Change {
    /// The first frame, or a new tree, focus, window state or title.
    New,
    /// Only bounds moved.
    BoundsOnly,
    /// Nothing.
    Nothing,
}

/// What `refresh` does with this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Skip,
    Build,
    /// Build after this long: repaint then.
    Defer(Duration),
}

/// This frame's step, given what changed, whether a screen reader listens,
/// and how long ago the tree was last built (None: never).
pub(crate) fn step(change: Change, listening: bool, since_built: Option<Duration>) -> Step {
    match change {
        Change::New => Step::Build,
        Change::Nothing => Step::Skip,
        Change::BoundsOnly if !listening => Step::Skip,
        Change::BoundsOnly => match since_built {
            Some(since) if since < LAYOUT_EVERY => Step::Defer(LAYOUT_EVERY - since),
            _ => Step::Build,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{step, Change, Step, LAYOUT_EVERY};

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn a_new_tree_builds_at_once_and_nothing_new_builds_nothing() {
        assert_eq!(step(Change::New, false, None), Step::Build);
        assert_eq!(step(Change::New, true, Some(MS(1))), Step::Build);
        assert_eq!(
            step(Change::Nothing, true, Some(LAYOUT_EVERY * 4)),
            Step::Skip
        );
    }

    #[test]
    fn moved_bounds_wait_while_nobody_listens() {
        assert_eq!(
            step(Change::BoundsOnly, false, Some(LAYOUT_EVERY * 4)),
            Step::Skip
        );
    }

    #[test]
    fn a_scroll_publishes_bounds_at_most_every_quarter_second_then_once_more() {
        // The frame after a publish waits out the rest of the quarter second…
        assert_eq!(
            step(Change::BoundsOnly, true, Some(MS(16))),
            Step::Defer(LAYOUT_EVERY - MS(16))
        );
        // …and once that has passed (the repaint after the wait), it builds.
        assert_eq!(
            step(Change::BoundsOnly, true, Some(LAYOUT_EVERY)),
            Step::Build
        );
        assert_eq!(step(Change::BoundsOnly, true, None), Step::Build);
    }
}
