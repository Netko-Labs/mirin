//! How the retained subtrees of a frame were drawn, for the trace.

use crate::gpui_api::RetainedDraw;

/// How many retained subtrees were drawn each way (traced per frame).
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub(crate) struct Counts {
    /// Built: their content changed or they were notified.
    pub built: u32,
    /// Built again for the layout they kept (they could not be copied).
    pub redrawn: u32,
    /// Last frame's drawing copied where it was.
    pub reused: u32,
    /// Last frame's drawing copied to where they moved.
    pub moved: u32,
    /// Not drawn: nothing of them shows.
    pub skipped: u32,
}

thread_local! {
    /// Since the last `take_counts`.
    static COUNTS: std::cell::Cell<Counts> = const {
        std::cell::Cell::new(Counts { built: 0, redrawn: 0, reused: 0, moved: 0, skipped: 0 })
    };
}

/// How the retained subtrees were drawn since the last call.
pub(crate) fn take_counts() -> Counts {
    COUNTS.with(|counts| counts.replace(Counts::default()))
}

pub(super) fn count(draw: RetainedDraw) {
    COUNTS.with(|counts| {
        let mut now = counts.get();
        match draw {
            RetainedDraw::Built => now.built += 1,
            RetainedDraw::Redrawn => now.redrawn += 1,
            RetainedDraw::Reused => now.reused += 1,
            RetainedDraw::Moved => now.moved += 1,
            RetainedDraw::Skipped => now.skipped += 1,
        }
        counts.set(now);
    });
}
