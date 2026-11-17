//! A view's opacity in a loop (`pulse`): a tag that breathes, at a few
//! steps a second, never at the display's rate.
//!
//! An animation that asks for every frame holds the GPU at 60 fps or more
//! for as long as it runs, for a tag a few pixels high. A pulse instead is
//! worked out from the clock when the window renders, rounded down to its
//! step (`fps`, 4 a second unless given, at most 10), and the window asks
//! to be rendered again at the next step: one timer for every pulse in it,
//! at the earliest step any of them needs. Between steps nothing is drawn.
//!
//! The opacity goes from `to` down to `from` and back over `periodMs`, as
//! a cosine (eased at both ends). Every pulse keeps time from the host's
//! start, so two with the same period breathe together. Under Reduce
//! Motion (`{"reduceMotion":true}` from the driver, or
//! `MIRIN_METAL_REDUCE_MOTION=1` as the host starts) and under a check
//! (`MIRIN_METAL_CHECK=1`, whose frames must settle) a pulse stands still
//! at `to` and asks for no frame. A host that takes `pulse` and the
//! `reduceMotion` line says `"pulse":true` in its `protocol` line; one from
//! before refuses a tree with it.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sumi::Context;

use crate::window::RootView;

/// In the host binary while views may pulse (`pulse`, `reduceMotion`).
pub const PULSE_MARKER: &str = "MIRIN_METAL_PULSE";

/// Steps a second without `fps`, and the most a pulse may ask for.
const DEFAULT_FPS: f32 = 4.0;
const MAX_FPS: f32 = 10.0;
/// The shortest period: anything quicker flickers at a few steps a second.
const MIN_PERIOD_MS: f32 = 400.0;

/// A view's `pulse`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Pulse {
    /// The faintest it gets (0–1).
    pub from: f32,
    /// The fullest it gets, and where it stands under Reduce Motion (0–1).
    pub to: f32,
    /// One breath, down and up again.
    pub period_ms: f32,
    /// Steps a second, 1 to 10.
    pub fps: Option<f32>,
}

impl Default for Pulse {
    fn default() -> Self {
        Pulse {
            from: 0.4,
            to: 1.0,
            period_ms: 2000.0,
            fps: None,
        }
    }
}

impl Pulse {
    fn step(&self) -> Duration {
        let fps = self
            .fps
            .filter(|fps| fps.is_finite())
            .unwrap_or(DEFAULT_FPS);
        Duration::from_nanos((1e9 / f64::from(fps.clamp(1.0, MAX_FPS))).round() as u64)
    }

    fn period_ms(&self) -> f32 {
        if self.period_ms.is_finite() {
            self.period_ms.max(MIN_PERIOD_MS)
        } else {
            MIN_PERIOD_MS
        }
    }

    /// The opacity `elapsed` after the host started, held for the whole step
    /// it falls in, and when the next step starts.
    pub(crate) fn at(&self, elapsed: Duration) -> (f32, Duration) {
        let step = self.step();
        let steps = elapsed.as_nanos() / step.as_nanos();
        let shown = step * steps as u32;
        let phase = (shown.as_secs_f64() * 1000.0 / f64::from(self.period_ms())).fract();
        let wave = 0.5 + 0.5 * (std::f64::consts::TAU * phase).cos();
        let (from, to) = (self.from.clamp(0.0, 1.0), self.to.clamp(0.0, 1.0));
        let opacity = from + (to - from) * wave as f32;
        (opacity, shown + step)
    }

    /// Where it stands still: under Reduce Motion and under a check.
    pub(crate) fn still(&self) -> f32 {
        self.to.clamp(0.0, 1.0)
    }
}

/// What every pulse keeps time from.
fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// Reduce Motion for the host: unset (0), off (1), on (2). One host draws
/// one window at a time, and a resident host's window comes and goes, so it
/// is the host's, not a window's.
static REDUCE: AtomicU8 = AtomicU8::new(0);

/// Whether pulses stand still: Reduce Motion is on (the driver's word, else
/// `MIRIN_METAL_REDUCE_MOTION=1`), or a check is driving the window.
pub(crate) fn reduced() -> bool {
    let said = match REDUCE.load(Ordering::Relaxed) {
        0 => std::env::var("MIRIN_METAL_REDUCE_MOTION").is_ok_and(|value| value == "1"),
        said => said == 2,
    };
    said || crate::check::enabled()
}

/// The driver turned Reduce Motion on or off (`{"reduceMotion":…}`).
/// Whether pulses now draw otherwise: the window renders again then.
pub(crate) fn set_reduce_motion(reduce: bool) -> bool {
    let was = reduced();
    REDUCE.store(if reduce { 2 } else { 1 }, Ordering::Relaxed);
    reduced() != was
}

/// A window's pulses: the next step one needs, and its timer.
#[derive(Default)]
pub(crate) struct Pulses {
    /// The earliest next step a pulse rendered this frame asked for.
    wake: Option<Duration>,
    /// A timer is waiting to render the window again.
    waiting: Rc<Cell<bool>>,
    /// Timers started, for tests.
    #[cfg(test)]
    armed: u32,
}

impl Pulses {
    /// A frame starts: no pulse has asked for a step yet.
    pub(crate) fn begin(&mut self) {
        self.wake = None;
    }

    /// A pulsing view's opacity this frame (its own `opacity` times the
    /// pulse's), noting the step it needs next; still when `reduce` (`reduced()`).
    pub(crate) fn opacity(&mut self, pulse: &Pulse, own: Option<f32>, reduce: bool) -> f32 {
        let own = own.unwrap_or(1.0);
        if reduce {
            return own * pulse.still();
        }
        thread_local!(static TRACED: Cell<bool> = const { Cell::new(false) });
        if !TRACED.with(|traced| traced.replace(true)) {
            crate::trace::log(format_args!("{PULSE_MARKER}: a view pulsed"));
        }
        let (opacity, next) = pulse.at(epoch().elapsed());
        self.wake = Some(self.wake.map_or(next, |wake| wake.min(next)));
        own * opacity
    }

    /// Whether a timer waits to render the window at a pulse's next step,
    /// and how many have been started.
    #[cfg(test)]
    pub(crate) fn timers(&self) -> (bool, u32) {
        (self.waiting.get(), self.armed)
    }

    /// The frame is built: render again at the earliest step a pulse needs,
    /// unless a timer already will.
    pub(crate) fn schedule(&mut self, cx: &mut Context<RootView>) {
        let Some(wake) = self.wake.take() else {
            return;
        };
        if self.waiting.replace(true) {
            return;
        }
        #[cfg(test)]
        {
            self.armed += 1;
        }
        let delay = wake.saturating_sub(epoch().elapsed());
        let waiting = Rc::clone(&self.waiting);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            waiting.set(false);
            // The window may be gone by then: nothing to render.
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{Pulse, Pulses};
    use crate::tree::{parse_tree, NodeSpec};

    fn ms(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    #[test]
    fn a_pulse_breathes_down_and_up_in_whole_steps() {
        let pulse = Pulse {
            from: 0.2,
            to: 1.0,
            period_ms: 2000.0,
            fps: Some(2.0),
        };
        // Full at the start of a breath, faintest halfway, full again.
        assert_eq!(pulse.at(ms(0)), (1.0, ms(500)));
        let (half, next) = pulse.at(ms(1000));
        assert!((half - 0.2).abs() < 1e-6, "{half}");
        assert_eq!(next, ms(1500));
        // Inside a step the opacity holds: 1,000 to 1,499 ms are one step.
        assert_eq!(pulse.at(ms(1499)), pulse.at(ms(1000)));
        assert_eq!(pulse.at(ms(2000)).0, 1.0);
    }

    #[test]
    fn a_pulse_never_asks_for_more_than_ten_steps_a_second() {
        let fast = Pulse {
            fps: Some(60.0),
            ..Pulse::default()
        };
        assert_eq!(fast.at(ms(0)).1, ms(100));
        let unsaid = Pulse::default();
        assert_eq!(unsaid.at(ms(0)).1, ms(250));
        let broken = Pulse {
            fps: Some(f32::NAN),
            period_ms: f32::INFINITY,
            ..Pulse::default()
        };
        assert_eq!(broken.at(ms(0)).1, ms(250));
    }

    #[test]
    fn reduce_motion_holds_a_pulse_still_and_asks_for_no_frame() {
        let pulse = Pulse::default();
        let mut pulses = Pulses::default();
        pulses.begin();
        pulses.opacity(&pulse, Some(0.5), false);
        assert!(
            pulses.wake.is_some(),
            "a moving pulse asks for its next step"
        );
        pulses.begin();
        assert_eq!(pulses.opacity(&pulse, Some(0.5), true), 0.5);
        assert_eq!(pulses.wake, None);
    }

    #[test]
    fn the_earliest_step_of_the_frame_wins() {
        let mut pulses = Pulses::default();
        pulses.begin();
        let slow = Pulse {
            fps: Some(1.0),
            ..Pulse::default()
        };
        let quick = Pulse {
            fps: Some(10.0),
            ..Pulse::default()
        };
        pulses.opacity(&slow, None, false);
        let after_slow = pulses.wake.expect("asked");
        pulses.opacity(&quick, None, false);
        assert!(pulses.wake.expect("asked") <= after_slow);
    }

    #[test]
    fn a_view_takes_a_pulse_and_refuses_a_stray_key() {
        let json =
            r#"{"type":"view","props":{"id":"now","pulse":{"from":0.5,"periodMs":1600,"fps":2}}}"#;
        let NodeSpec::View { props, .. } = parse_tree(json).expect("a pulse parses") else {
            panic!("not a view");
        };
        assert_eq!(
            props.pulse,
            Some(Pulse {
                from: 0.5,
                to: 1.0,
                period_ms: 1600.0,
                fps: Some(2.0)
            })
        );
        let stray = r#"{"type":"view","props":{"pulse":{"speed":2}}}"#;
        assert!(parse_tree(stray).is_err());
    }
}

// Pulses drawn by GPUI on its test platform, through the host's `RootView`.
#[cfg(test)]
mod drawn_tests;
