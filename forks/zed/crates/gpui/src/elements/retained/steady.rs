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
//!   computed elsewhere. Its axis is `fixed`, or, for one nearer a half than
//!   that but further than `f32` can lose where it lands (`near`, judged in
//!   `holds` from how far the move takes it), held.
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
/// mirin: how many units in the last place `f32` may lose computing a
/// position again elsewhere: one sum per level from the layout's root
/// (`layout_bounds`), each off by at most half a unit, there and here;
/// enough for 32 levels.
const ULPS: f32 = 32.;

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
    /// mirin: per axis, of the positions within [`EDGE`] of a half that are
    /// not exactly there (layouts with text a fraction of a pixel tall have
    /// many), the least distance to it and the greatest magnitude (device
    /// pixels): moved, each rounds as it did while `f32` loses less than
    /// that distance (`holds`).
    near: [(f32, f32); 2],
    /// mirin: per axis, the least and greatest position rounded to the
    /// device pixel (device pixels). Moved by whole pixels without any of
    /// them leaving its binade (between two powers of two), every `f32` sum
    /// that placed them moves exactly (`holds`).
    range: [(f32, f32); 2],
}

impl Default for Steadiness {
    fn default() -> Self {
        Self {
            fixed: [false; 2],
            halves: [(f32::INFINITY, f32::NEG_INFINITY); 2],
            near: [(f32::INFINITY, 0.); 2],
            range: [(f32::INFINITY, f32::NEG_INFINITY); 2],
        }
    }
}

impl Steadiness {
    /// `value` (in units of `1 / units` device pixels) is rounded to the
    /// nearest whole unit, halves toward zero. `exact`: it was computed
    /// with exact arithmetic from positions moved whole.
    pub(crate) fn round_half(&mut self, axis: usize, value: f32, units: f32, exact: bool) {
        if units == 1. {
            let (least, greatest) = &mut self.range[axis];
            *least = least.min(value);
            *greatest = greatest.max(value);
        }
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
        let distance = (fraction - 0.5).abs();
        if distance > 0. && units == 1. {
            let (least, greatest) = &mut self.near[axis];
            *least = least.min(distance);
            *greatest = greatest.max(value.abs());
            return;
        }
        self.fixed[axis] = true;
    }

    /// `value` (device pixels) is floored or ceiled to a whole pixel.
    pub(crate) fn floor(&mut self, axis: usize, value: f32, exact: bool) {
        // mirin: kept in the range, and held when near a whole pixel but
        // not on it, as `round_half` does near a half.
        let (least, greatest) = &mut self.range[axis];
        *least = least.min(value);
        *greatest = greatest.max(value);
        let fraction = value.abs().fract();
        let distance = fraction.min(1. - fraction);
        if distance > EDGE || (fraction == 0. && exact && is_exact(value)) {
            return;
        }
        if distance > 0. {
            let (least, greatest) = &mut self.near[axis];
            *least = least.min(distance);
            *greatest = greatest.max(value.abs());
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

    /// mirin: where scaling is not exact (`grid`), `round_half` for a
    /// position the scale factor multiplied: `f32` puts it a few units off
    /// what multiplying it moved gives, so within [`EDGE`] of a half fixes
    /// its axis (`near` and the binades in `holds_within` hold for sums
    /// alone, not products by a scale that is not a power of two).
    pub(crate) fn round_half_scaled(&mut self, axis: usize, value: f32) {
        if (value.abs().fract() - 0.5).abs() <= EDGE {
            self.fixed[axis] = true;
        }
    }

    /// Where scaling is not exact (`grid`): `value` (device pixels) is
    /// settled (`Grid::settle`), then floored or ceiled. It lands the same
    /// moved unless it is near where settling turns.
    pub(crate) fn settled_floor(&mut self, axis: usize, value: f32) {
        let off = (value - value.round()).abs();
        if (off - super::grid::SNAP).abs() < super::grid::ON_GRID {
            self.fixed[axis] = true;
        }
    }

    /// Where scaling is not exact: a position used unrounded moves through
    /// its device position (`value`), which must be on the grid.
    pub(crate) fn on_grid(&mut self, axis: usize, value: f32) {
        if !super::grid::is_on_grid(value) {
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
            let (least, greatest) = &mut self.near[axis];
            *least = least.min(other.near[axis].0);
            *greatest = greatest.max(other.near[axis].1);
            let (least, greatest) = &mut self.range[axis];
            *least = least.min(other.range[axis].0);
            *greatest = greatest.max(other.range[axis].1);
        }
    }

    /// Whether every position rounds as it did once moved `by` device
    /// pixels (whole ones).
    pub(crate) fn holds(&self, by: Point<f32>) -> bool {
        self.holds_within(by, Point { x: 0., y: 0. })
    }

    /// mirin: `holds`, for a move of `by` whole device pixels give or take
    /// `slack` (`f32` that summed where it is now lost that much: a
    /// position that crossed a power of two on the way): a position near a
    /// half holds while further from it than that and what `f32` loses.
    pub(crate) fn holds_within(&self, by: Point<f32>, slack: Point<f32>) -> bool {
        [(by.x, slack.x), (by.y, slack.y)]
            .into_iter()
            .enumerate()
            .all(|(axis, (by, slack))| {
                let (positive, negative) = self.halves[axis];
                let (least, greatest) = self.near[axis];
                (by == 0. && slack == 0.)
                    || (!self.fixed[axis]
                        && positive + by > slack
                        && negative + by < -slack
                        && (least == f32::INFINITY
                            || (slack == 0. && within_binades(self.range[axis], by))
                            || least > slack + ULPS * ulp(greatest + by.abs())))
            })
    }

    /// The same positions, `by` device pixels on.
    pub(crate) fn moved(&mut self, by: Point<f32>) {
        for (axis, by) in [by.x, by.y].into_iter().enumerate() {
            self.halves[axis].0 += by;
            self.halves[axis].1 += by;
            self.near[axis].1 += by.abs();
            self.range[axis].0 += by;
            self.range[axis].1 += by;
        }
    }
}

/// mirin: whether every position in `range` (least, greatest), moved `by`,
/// stays in its binade: of one sign, and between the same two powers of two
/// (below 2^22, where moving by whole pixels is a multiple of the unit in
/// the last place). Then a sum `f32` made there, made again moved, is the
/// sum moved: rounding commutes with a shift by a multiple of the unit.
fn within_binades((least, greatest): (f32, f32), by: f32) -> bool {
    let low = least.min(least + by);
    let high = greatest.max(greatest + by);
    let binade = |value: f32| value.abs().max(f32::MIN_POSITIVE).log2().floor();
    low <= high
        && (low > 0. || high < 0.)
        && high.abs().max(low.abs()) < 4_194_304.
        && binade(low) == binade(high)
}

/// mirin: the distance from a positive `f32` below `value` to the next one up
/// (at least that of 1, `f32::EPSILON`).
fn ulp(value: f32) -> f32 {
    let exponent = value.max(1.).log2().floor();
    (exponent - 23.).exp2()
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
    fn near_a_half_where_scaling_is_not_exact_fixes_its_axis() {
        // mirin: not held as a sum near a half is (`round_half_scaled`).
        let mut steady = Steadiness::default();
        steady.round_half_scaled(0, 10.499);
        steady.round_half_scaled(1, 10.3);
        assert!(steady.fixed[0] && !steady.fixed[1]);
        assert!(!steady.holds(point(1., 0.)) && steady.holds(point(0., 1.)));
    }

    #[test]
    fn a_position_near_where_rounding_turns_fixes_its_axis() {
        // mirin: near a half, not on it: holds while `f32` can't move it
        // across, which depends on how far.
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.499, 1., true);
        assert!(!steady.fixed[0]);
        assert!(steady.holds(point(100., 0.)));
        assert!(!steady.holds(point(100_000., 0.)));
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.49999, 1., true);
        assert!(!steady.holds(point(100., 0.)));
        // Within its binade (8 to 16), a move is exact however near.
        assert!(steady.holds(point(5., 0.)));
        assert!(!steady.holds(point(6., 0.)));
        let mut steady = Steadiness::default();
        steady.round_half(0, 4. * 3.1249, 4., true);
        assert!(steady.fixed[0]);
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.5, 1., false);
        assert!(steady.fixed[0]);
        let mut steady = Steadiness::default();
        steady.round_half(0, 10.3, 1., false);
        steady.floor(1, 7.0, true);
        steady.floor(1, 7.5, false);
        assert!(!steady.fixed[0] && !steady.fixed[1]);
        steady.floor(1, 7.0, false);
        assert!(steady.fixed[1]);
        // mirin: near a whole pixel, not on it: held while exact.
        let mut steady = Steadiness::default();
        steady.floor(1, 6.9999, false);
        assert!(!steady.fixed[1] && steady.holds(point(0., -2.)));
        // A glyph's subpixel variant: halves of a quarter pixel.
        let mut steady = Steadiness::default();
        steady.round_half(0, 4. * 3.125, 4., true);
        assert!(!steady.fixed[0]);
        assert!(!steady.holds(point(-4., 0.)));
        assert!(steady.holds(point(-3., 0.)));
    }
}
