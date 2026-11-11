//! `heightTransitionMs`: a view whose content height changes follows it over
//! a few hundred ms instead of jumping (a launcher's list growing as results
//! come). The view is drawn inside a clip whose height is eased from the old
//! content height to the new one; the content is laid out at its natural
//! height inside it, and measured after layout each frame. The first frame
//! is drawn at the natural height: appearing doesn't animate.
//!
//! The clip is a block, so the view's own flex sizing (`flex`, `grow`) has no
//! effect inside it, and it cuts what the view draws outside itself (a
//! shadow): put the transition on a content-sized view inside the one that
//! casts the shadow.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{div, prelude::*, px, AnyElement, Window};

use crate::tree::{Align, NodeSpec, ViewProps};

/// Longer than this is no longer a transition.
pub(crate) const MAX_MS: f32 = 1000.0;
/// Height changes smaller than this (px) are layout jitter, not a change.
const EPSILON: f32 = 0.5;

/// The compositor's curve, as Dashi's motion uses it: `1 − (1 − t)³`.
pub(crate) fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// The transition a view asked for, in ms: positive, finite, at most `MAX_MS`.
pub(crate) fn transition_ms(props: &ViewProps) -> Option<f32> {
    props
        .height_transition_ms
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map(|ms| ms.min(MAX_MS))
}

/// One height on its way to another.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Motion {
    pub(crate) from: f32,
    pub(crate) to: f32,
    pub(crate) started: Instant,
    pub(crate) duration: Duration,
}

impl Motion {
    /// The eased height at `now`, and whether it has arrived.
    pub(crate) fn at(&self, now: Instant) -> (f32, bool) {
        let elapsed = now.saturating_duration_since(self.started).as_secs_f32();
        let total = self.duration.as_secs_f32();
        let t = if total > 0.0 { elapsed / total } else { 1.0 };
        if t >= 1.0 {
            return (self.to, true);
        }
        (self.from + (self.to - self.from) * ease_out_cubic(t), false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum HeightState {
    /// Drawn at this height, its content's last measured one.
    Settled(f32),
    Moving(Motion),
}

/// Every transitioning view's state, by id; shared with the prepaint
/// callbacks that measure the content.
#[derive(Clone, Default)]
pub(crate) struct Heights(Rc<RefCell<HashMap<String, HeightState>>>);

impl Heights {
    /// The height to draw `id`'s clip at `now` (None: its natural height, the
    /// first time), and whether it is still moving.
    pub(crate) fn painted(&self, id: &str, now: Instant) -> (Option<f32>, bool) {
        let mut states = self.0.borrow_mut();
        match states.get(id).copied() {
            None => (None, false),
            Some(HeightState::Settled(height)) => (Some(height), false),
            Some(HeightState::Moving(motion)) => {
                let (height, arrived) = motion.at(now);
                if arrived {
                    states.insert(id.to_string(), HeightState::Settled(motion.to));
                }
                (Some(height), !arrived)
            }
        }
    }

    /// The content's natural height after layout. True when that started a
    /// transition (or turned one toward a new height): the caller asks for
    /// the next frame.
    pub(crate) fn measured(&self, id: &str, natural: f32, ms: f32, now: Instant) -> bool {
        let duration = Duration::from_secs_f32(ms.clamp(0.0, MAX_MS) / 1000.0);
        let mut states = self.0.borrow_mut();
        let from = match states.get(id).copied() {
            None => {
                states.insert(id.to_string(), HeightState::Settled(natural));
                return false;
            }
            Some(HeightState::Settled(height)) => {
                if (height - natural).abs() < EPSILON {
                    return false;
                }
                height
            }
            Some(HeightState::Moving(motion)) => {
                if (motion.to - natural).abs() < EPSILON {
                    return false;
                }
                motion.at(now).0
            }
        };
        states.insert(
            id.to_string(),
            HeightState::Moving(Motion {
                from,
                to: natural,
                started: now,
                duration,
            }),
        );
        true
    }

    /// Forget views that left the tree or no longer transition.
    pub(crate) fn sync(&self, tree: &NodeSpec) {
        let mut ids = HashSet::new();
        collect_ids(tree, &mut ids);
        self.0.borrow_mut().retain(|id, _| ids.contains(id));
    }

    #[cfg(test)]
    fn state(&self, id: &str) -> Option<HeightState> {
        self.0.borrow().get(id).copied()
    }
}

/// Ids of the views in `node` with a height transition.
fn collect_ids(node: &NodeSpec, ids: &mut HashSet<String>) {
    if let NodeSpec::View { props, children } = node {
        if let (Some(id), Some(_)) = (props.id.as_ref(), transition_ms(props)) {
            ids.insert(id.clone());
        }
        for child in children {
            collect_ids(child, ids);
        }
    }
}

/// `content` (the view `id`, already rendered) inside its clip.
pub(crate) fn clip(
    content: AnyElement,
    id: &str,
    ms: f32,
    props: &ViewProps,
    heights: &Heights,
    window: &mut Window,
) -> AnyElement {
    let (height, moving) = heights.painted(id, Instant::now());
    if moving {
        window.request_animation_frame();
    }
    // A block: the content keeps its natural height whatever the clip's.
    let mut clip = div().flex_shrink_0().overflow_hidden();
    if let Some(height) = height {
        clip = clip.h(px(height));
    }
    if let Some(align) = props.align_self {
        clip.style().align_self = Some(match align {
            Align::Start => gpui::AlignItems::FlexStart,
            Align::Center => gpui::AlignItems::Center,
            Align::End => gpui::AlignItems::FlexEnd,
            Align::Stretch => gpui::AlignItems::Stretch,
        });
    }
    let heights = heights.clone();
    let key = id.to_string();
    clip.child(content)
        .on_children_prepainted(move |bounds, window, _cx| {
            let Some(content) = bounds.first() else {
                return;
            };
            let natural = f32::from(content.size.height);
            if heights.measured(&key, natural, ms, Instant::now()) {
                window.request_animation_frame();
            }
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn the_curve_decelerates_and_lands() {
        assert_eq!(ease_out_cubic(0.0), 0.0);
        assert_eq!(ease_out_cubic(1.0), 1.0);
        assert!((ease_out_cubic(0.5) - 0.875).abs() < 1e-6);
        assert_eq!(ease_out_cubic(2.0), 1.0);
        assert_eq!(ease_out_cubic(-1.0), 0.0);
    }

    #[test]
    fn only_a_positive_finite_transition_counts_and_it_is_capped() {
        let mut props = ViewProps::default();
        assert_eq!(transition_ms(&props), None);
        props.height_transition_ms = Some(0.0);
        assert_eq!(transition_ms(&props), None);
        props.height_transition_ms = Some(f32::NAN);
        assert_eq!(transition_ms(&props), None);
        props.height_transition_ms = Some(120.0);
        assert_eq!(transition_ms(&props), Some(120.0));
        props.height_transition_ms = Some(5000.0);
        assert_eq!(transition_ms(&props), Some(MAX_MS));
    }

    #[test]
    fn appearing_does_not_animate() {
        let heights = Heights::default();
        let now = Instant::now();
        assert_eq!(heights.painted("list", now), (None, false));
        assert!(!heights.measured("list", 115.0, 120.0, now));
        assert_eq!(heights.painted("list", now), (Some(115.0), false));
    }

    #[test]
    fn a_new_content_height_is_eased_to() {
        let heights = Heights::default();
        let start = Instant::now();
        heights.measured("list", 100.0, 120.0, start);
        assert!(heights.measured("list", 300.0, 120.0, start));
        let (half, moving) = heights.painted("list", start + ms(60));
        assert!(moving);
        // Halfway in time, 87.5% of the way there.
        let half = half.unwrap_or_default();
        assert!((half - 275.0).abs() < 0.5, "{half}");
        assert_eq!(
            heights.painted("list", start + ms(130)),
            (Some(300.0), false)
        );
        assert_eq!(heights.state("list"), Some(HeightState::Settled(300.0)));
    }

    #[test]
    fn the_same_height_again_is_no_transition() {
        let heights = Heights::default();
        let now = Instant::now();
        heights.measured("list", 100.0, 120.0, now);
        assert!(!heights.measured("list", 100.2, 120.0, now));
        heights.measured("list", 200.0, 120.0, now);
        // Still on its way to 200: measuring 200 again doesn't restart it.
        assert!(!heights.measured("list", 200.0, 120.0, now + ms(10)));
    }

    #[test]
    fn a_change_midway_turns_from_where_it_is() {
        let heights = Heights::default();
        let start = Instant::now();
        heights.measured("list", 100.0, 120.0, start);
        heights.measured("list", 300.0, 120.0, start);
        let (now_at, _) = heights.painted("list", start + ms(60));
        let now_at = now_at.unwrap_or_default();
        assert!(heights.measured("list", 50.0, 120.0, start + ms(60)));
        match heights.state("list") {
            Some(HeightState::Moving(motion)) => {
                assert!((motion.from - now_at).abs() < 0.5);
                assert_eq!(motion.to, 50.0);
            }
            other => panic!("expected a motion, got {other:?}"),
        }
    }

    #[test]
    fn views_that_leave_are_forgotten() {
        let heights = Heights::default();
        let now = Instant::now();
        heights.measured("list", 100.0, 120.0, now);
        heights.measured("gone", 100.0, 120.0, now);
        let tree = crate::tree::parse_tree(
            r#"{"type":"view","props":{"id":"root"},"children":[{"type":"view","props":{"id":"list","heightTransitionMs":120}}]}"#,
        )
        .expect("a valid tree");
        heights.sync(&tree);
        assert!(heights.state("list").is_some());
        assert!(heights.state("gone").is_none());
    }
}
