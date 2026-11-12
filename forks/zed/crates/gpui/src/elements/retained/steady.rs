//! mirin: whether the positions a retained subtree rounds (to device
//! pixels, to a glyph's subpixel variant) land the same way when the same
//! subtree is drawn a whole number of device pixels away.
//!
//! Upstream rounds absolute positions: a node's edges in `layout_bounds`,
//! a primitive's in `Window::paint_*`. Moved by whole device pixels, a
//! position rounds to the same place that many pixels on, as long as
//! computing it there gives the position moved exactly, or close enough
//! that rounding can't tell. Two cases can tell:
//!
//! - a position within [`EDGE`] of where its rounding turns (a half for
//!   rounding to nearest, a whole pixel for floor and ceil) that is not
//!   exactly there by exact arithmetic: `f32` may put it either side once
//!   computed elsewhere. Its axis is `fixed`.
//! - a position exactly on a half: upstream rounds halves toward zero, so
//!   one that crosses zero (content scrolled past the window's edge) lands
//!   a pixel off. The halves nearest zero on either side are kept, and a
//!   move that would take one across zero is refused.

use crate::Point;

/// How close to where its rounding turns a position may be for `f32`'s
/// loss (a few units in the last place, below 2^16) not to decide it.
const EDGE: f32 = 1. / 64.;
/// Positions below this, in multiples of 1/256, sum exactly in `f32` with
/// whole moves.
const EXACT_BELOW: f32 = 32768.;

/// Whether `value` is one `f32` sums exactly with whole moves.
pub(crate) fn is_exact(value: f32) -> bool {
    value.abs() < EXACT_BELOW && (value * 256.).fract() == 0.
}

/// What a retained subtree's drawing rounds, and how it would round moved.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Steadiness {
    /// Along this axis, some position could round differently moved.
    pub(crate) fixed: [bool; 2],
    /// Per axis, the least positive and the greatest negative position
    /// (device pixels) that rounds exactly at a half.
    halves: [(f32, f32); 2],
}

impl Default for Steadiness {
    fn default() -> Self {
        Self {
            fixed: [false; 2],
            halves: [(f32::INFINITY, f32::NEG_INFINITY); 2],
        }
    }
}

impl Steadiness {
    /// `value` (in units of `1 / units` device pixels) is rounded to the
    /// nearest whole unit, halves toward zero. `exact`: it was computed
    /// with exact arithmetic from positions moved whole.
    pub(crate) fn round_half(&mut self, axis: usize, value: f32, units: f32, exact: bool) {
        let fraction = value.abs().fract();
        if (fraction - 0.5).abs() > EDGE {
            return;
        }
        if fraction == 0.5 && exact && is_exact(value / units) {
            let device = value / units;
            let (positive, negative) = &mut self.halves[axis];
            if device > 0. {
                *positive = positive.min(device);
            } else {
                *negative = negative.max(device);
            }
            return;
        }
        self.fixed[axis] = true;
    }

    /// `value` (device pixels) is floored or ceiled to a whole pixel.
    pub(crate) fn floor(&mut self, axis: usize, value: f32, exact: bool) {
        let fraction = value.abs().fract();
        if fraction.min(1. - fraction) > EDGE || (fraction == 0. && exact && is_exact(value)) {
            return;
        }
        self.fixed[axis] = true;
    }

    /// A position is used as it is, unrounded: it moves exactly only when
    /// it is exact.
    pub(crate) fn exact(&mut self, axis: usize, value: f32) {
        if !is_exact(value) {
            self.fixed[axis] = true;
        }
    }

    /// What a subtree inside rounds is this one's too.
    pub(crate) fn merge(&mut self, other: &Steadiness) {
        for axis in 0..2 {
            self.fixed[axis] |= other.fixed[axis];
            let (positive, negative) = &mut self.halves[axis];
            *positive = positive.min(other.halves[axis].0);
            *negative = negative.max(other.halves[axis].1);
        }
    }

    /// Whether every position rounds as it did once moved `by` device
    /// pixels (whole ones).
    pub(crate) fn holds(&self, by: Point<f32>) -> bool {
        [by.x, by.y].into_iter().enumerate().all(|(axis, by)| {
            let (positive, negative) = self.halves[axis];
            by == 0. || (!self.fixed[axis] && positive + by > 0. && negative + by < 0.)
        })
    }

    /// The same positions, `by` device pixels on.
    pub(crate) fn moved(&mut self, by: Point<f32>) {
        for (axis, by) in [by.x, by.y].into_iter().enumerate() {
            self.halves[axis].0 += by;
            self.halves[axis].1 += by;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::point;

    #[test]
    fn a_half_holds_until_a_move_takes_it_across_zero() {
        let mut steady = Steadiness::default();
        steady.round_half(1, 10.5, 1., true);
        steady.round_half(1, -3.5, 1., true);
        assert!(!steady.fixed[1]);
        assert!(steady.holds(point(0., 3.)));
        assert!(!steady.holds(point(0., 4.)));
        assert!(steady.holds(point(0., -10.)));
        assert!(!steady.holds(point(0., -11.)));
        // Across, nothing was rounded.
        assert!(steady.holds(point(100., 0.)));
        steady.moved(point(0., 3.));
        assert!(!steady.holds(point(0., 1.)));
    }

    #[test]
    fn a_position_near_where_rounding_turns_fixes_its_axis() {
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.499, 1., true);
        assert!(steady.fixed[0]);
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.5, 1., false);
        assert!(steady.fixed[0]);
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.3, 1., false);
        steady.floor(1, 7.0, true);
        steady.floor(1, 7.5, false);
        assert!(!steady.fixed[0] && !steady.fixed[1]);
        steady.floor(1, 6.9999, false);
        assert!(steady.fixed[1]);
        // A glyph's subpixel variant: halves of a quarter pixel.
        let mut steady = Steadiness::default();
        steady.round_half(0, 4. * 3.125, 4., true);
        assert!(!steady.fixed[0]);
        assert!(!steady.holds(point(-4., 0.)));
        assert!(steady.holds(point(-3., 0.)));
    }
}
