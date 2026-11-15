//! Check mode (`MIRIN_METAL_CHECK=1`): a window driven by a check instead of
//! a person, so that the check needs no waits and several can run at once.
//!
//! - The window hears only simulated input (`sim.rs`): what the platform
//!   delivers (the person's pointer crossing the window, their keyboard) is
//!   dropped.
//! - Animations read a clock that only `settle` moves (`now`), a step for
//!   every frame an animation asked for, so a scroll bar's fade or a height
//!   transition runs through all its frames at once and ends the same on
//!   every run, however busy the machine.
//! - `settle` draws the frames the window waits for itself (`drive.rs`)
//!   instead of waiting for the compositor to ask for each.
//!
//! Without it `settle` still answers, at the pace frames come.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Named by a host binary that takes the `settle` simulation and answers
/// `settled`; its `protocol` line says `"settle": true` too.
pub const SETTLE_MARKER: &str = "MIRIN_METAL_SETTLE";

/// How far the animations' clock moves for each frame an animation asked
/// for: a scroll bar is drawn shown, part faded and gone, in five frames
/// after the scroll's own. (A nested compositor asks for a frame a second,
/// so a check that waited drew it in two or three.)
pub(crate) const FRAME_STEP: Duration = Duration::from_millis(250);

/// Whether this process runs under a check.
pub(crate) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MIRIN_METAL_CHECK").is_ok_and(|value| value == "1"))
}

/// A clock that stands still until it is moved.
pub(crate) struct Clock {
    started: Instant,
    moved_ms: AtomicU64,
}

impl Clock {
    pub(crate) fn new(started: Instant) -> Self {
        Self {
            started,
            moved_ms: AtomicU64::new(0),
        }
    }

    pub(crate) fn now(&self) -> Instant {
        self.started + Duration::from_millis(self.moved_ms.load(Ordering::Relaxed))
    }

    pub(crate) fn advance(&self, by: Duration) {
        let by = u64::try_from(by.as_millis()).unwrap_or(u64::MAX);
        self.moved_ms.fetch_add(by, Ordering::Relaxed);
    }
}

fn clock() -> &'static Clock {
    static CLOCK: OnceLock<Clock> = OnceLock::new();
    CLOCK.get_or_init(|| Clock::new(Instant::now()))
}

/// The time animations go by (a scroll bar's fade, a height transition):
/// the wall clock, or under a check the clock `advance` moves.
pub(crate) fn now() -> Instant {
    if enabled() {
        clock().now()
    } else {
        Instant::now()
    }
}

/// Under a check: a frame an animation asked for is about to be drawn.
pub(crate) fn advance() {
    clock().advance(FRAME_STEP);
}

#[cfg(test)]
mod tests {
    use super::{Clock, FRAME_STEP};
    use std::time::{Duration, Instant};

    #[test]
    fn the_clock_stands_still_until_it_is_moved() {
        let started = Instant::now();
        let clock = Clock::new(started);
        assert_eq!(clock.now(), started);
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(clock.now(), started);
        clock.advance(FRAME_STEP);
        clock.advance(FRAME_STEP);
        assert_eq!(clock.now(), started + FRAME_STEP * 2);
    }

    #[test]
    fn a_scroll_bar_fades_out_in_a_fixed_number_of_frames() {
        // What `settle` does for a bar shown by a scroll: a step a frame
        // until the bar asks for no more.
        let clock = Clock::new(Instant::now());
        let activity = crate::scrollbar::Activity::default();
        assert_eq!(activity.visibility((0.0, 0.0), clock.now()), 0.0);
        let mut frames = 0;
        let mut strengths = Vec::new();
        loop {
            let strength = activity.visibility((0.0, 120.0), clock.now());
            if strength <= 0.0 {
                break;
            }
            strengths.push(strength);
            clock.advance(FRAME_STEP);
            frames += 1;
            assert!(frames < 100, "the bar never fades");
        }
        assert_eq!(frames, 5);
        // Shown, then part faded: the fade is drawn, not skipped.
        assert_eq!(strengths[0], 1.0);
        assert!(strengths[4] > 0.0 && strengths[4] < 1.0);
    }
}
