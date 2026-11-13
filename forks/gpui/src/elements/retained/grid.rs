//! mirin: device positions a kept drawing can be moved between exactly.
//!
//! Layout is in device pixels (taffy rounds to them), but elements are
//! given logical bounds (`device / scale`) and every primitive scales its
//! own back up. At a scale factor that is a power of two both steps are
//! exact; at any other (1.25, 1.5, 1.75, 3, …) each loses a little, by an
//! amount that depends on where the element is, so a drawing copied a whole
//! number of device pixels away would differ in its last bits from the
//! same drawing made there. So positions are settled: a device position
//! within [`SNAP`] of the grid (an eighth of a device pixel: whole pixels,
//! and the halves and quarters a logical pixel scales to) is that grid
//! point, a logical one is the grid point divided by the scale factor, and
//! a move is applied to the grid point. A position farther off the grid
//! than [`ON`] stays as it was computed, and the drawing it is in is not
//! moved along that axis (`Recording::fixed`).
//!
//! The two distances leave room for what `f32` loses: a position that is
//! on the grid where it was drawn is at most `ON` plus that loss from it
//! where it is drawn again, well within `SNAP`, so both settle on the same
//! point.

use crate::{Bounds, Pixels, Point, ScaledPixels, point, size};

/// Grid points per device pixel.
const STEP: f32 = 8.;
/// A device position this close to a grid point is settled onto it.
const SNAP: f32 = 1. / 64.;
/// A device position this close to a grid point is on it.
const ON: f32 = 1. / 256.;
/// Past any window: an edge of a mask that is open on one side. Left alone.
const FAR: f32 = 1_048_576.;

/// The grid of a window at its scale factor.
#[derive(Clone, Copy)]
pub(crate) struct Grid {
    scale: f32,
    /// Scaling is exact (a power of two): nothing is settled, and a
    /// position is on the grid only when it is exactly.
    exact: bool,
}

impl Grid {
    pub(crate) fn new(scale: f32) -> Self {
        Self {
            scale,
            exact: scale > 0. && scale.log2().fract() == 0.,
        }
    }

    /// Scaling is exact: nothing is settled.
    pub(crate) fn is_exact(&self) -> bool {
        self.exact
    }

    /// The grid point a device position settles on and whether it is on
    /// it; `None` when it is off the grid (or, where scaling is exact, not
    /// exactly on it).
    fn near(&self, value: f32) -> Option<(f32, bool)> {
        let nearest = (value * STEP).round() / STEP;
        if self.exact {
            return (value == nearest).then_some((value, true));
        }
        let off = (value - nearest).abs();
        (off <= SNAP).then_some((nearest, off <= ON))
    }

    /// A distance something is drawn from its box (a shadow's offset), in
    /// device pixels, on the grid: the nearest grid point where scaling is
    /// not exact (a logical pixel at 1.1 is 1.125 device pixels; at 1.25 or
    /// 1.5 it is on the grid already, and stays as it is), unchanged where
    /// it is. Added to a position on the grid it stays on it.
    pub(crate) fn snap_distance(&self, device: f32) -> f32 {
        if self.exact || !(device.abs() < FAR) {
            return device;
        }
        (device * STEP).round() / STEP
    }

    /// A depth something is drawn to inside its box (a border's band), in
    /// device pixels: the same where it is on the grid (or scaling is
    /// exact), else the next grid point up, so it is never less.
    pub(crate) fn snap_up(&self, device: f32) -> f32 {
        if self.exact || !(device.abs() < FAR) {
            return device;
        }
        match self.near(device) {
            Some((point, true)) => point,
            _ => (device * STEP).ceil() / STEP,
        }
    }

    /// A device position settled, and whether it is on the grid.
    pub(crate) fn settle(&self, value: f32) -> (f32, bool) {
        if !(value.abs() < FAR) {
            return (value, true);
        }
        self.near(value).unwrap_or((value, false))
    }

    /// A logical position settled, and whether it is on the grid.
    pub(crate) fn settle_logical(&self, value: Pixels) -> (Pixels, bool) {
        let device = value.0 * self.scale;
        if !(device.abs() < FAR) {
            return (value, true);
        }
        match self.near(device) {
            Some((point, on)) if !self.exact => (Pixels(point / self.scale), on),
            Some((_, on)) => (value, on),
            None => (value, false),
        }
    }

    /// Where a node laid out at `device` (device pixels from the window's
    /// top left) is, with the element offset `offset` around it.
    pub(crate) fn place(&self, device: f32, offset: Pixels) -> Pixels {
        let by = offset.0 * self.scale;
        if !self.exact && by.abs() < FAR {
            if let Some((by, _)) = self.near(by) {
                // The offset is on the grid too: one division, however
                // far the offset is.
                return Pixels((device + by) / self.scale);
            }
        }
        Pixels(device / self.scale) + offset
    }

    /// How far `to` is from `from` in device pixels, when both are on the
    /// grid and that is a whole number of them along each axis.
    pub(crate) fn whole_move(&self, from: Point<Pixels>, to: Point<Pixels>) -> Option<Point<f32>> {
        let axis = |from: Pixels, to: Pixels| {
            let (from, from_on) = self.settle(from.0 * self.scale);
            let (to, to_on) = self.settle(to.0 * self.scale);
            let by = to - from;
            (from_on && to_on && by.fract() == 0.).then_some(by)
        };
        Some(point(axis(from.x, to.x)?, axis(from.y, to.y)?))
    }

    /// A logical position `by` device pixels (whole) from where it was.
    pub(crate) fn moved(&self, value: Pixels, by: f32) -> Pixels {
        if by == 0. || !(value.0.abs() < FAR) {
            return value;
        }
        if self.exact {
            return value + Pixels(by / self.scale);
        }
        let (device, _) = self.settle(value.0 * self.scale);
        Pixels((device + by) / self.scale)
    }

    pub(crate) fn moved_point(&self, point: Point<Pixels>, by: Point<f32>) -> Point<Pixels> {
        Point {
            x: self.moved(point.x, by.x),
            y: self.moved(point.y, by.y),
        }
    }

    /// The logical distance of a move by `by` device pixels (for what need
    /// not be exact: how far a drawing reaches, where it is whole).
    pub(crate) fn logical(&self, by: Point<f32>) -> Point<Pixels> {
        point(Pixels(by.x / self.scale), Pixels(by.y / self.scale))
    }

    /// Logical bounds settled, with whether the origin and the size are on
    /// the grid across and down (the far edge is when both are).
    pub(crate) fn settle_bounds(
        &self,
        bounds: Bounds<Pixels>,
    ) -> (Bounds<Pixels>, [bool; 2], [bool; 2]) {
        let (x, on_x) = self.settle_logical(bounds.origin.x);
        let (y, on_y) = self.settle_logical(bounds.origin.y);
        let (width, wide) = self.settle_logical(bounds.size.width);
        let (height, high) = self.settle_logical(bounds.size.height);
        (
            Bounds {
                origin: point(x, y),
                size: size(width, height),
            },
            [on_x, on_y],
            [wide, high],
        )
    }

    /// Device bounds settled, with whether the origin is on the grid
    /// across and down. A size is settled but never off the grid: it does
    /// not depend on where the primitive is.
    pub(crate) fn settle_device(
        &self,
        bounds: Bounds<ScaledPixels>,
    ) -> (Bounds<ScaledPixels>, [bool; 2]) {
        let (x, on_x) = self.settle(bounds.origin.x.0);
        let (y, on_y) = self.settle(bounds.origin.y.0);
        let (width, _) = self.settle(bounds.size.width.0);
        let (height, _) = self.settle(bounds.size.height.0);
        (
            Bounds {
                origin: point(ScaledPixels(x), ScaledPixels(y)),
                size: size(ScaledPixels(width), ScaledPixels(height)),
            },
            [on_x, on_y],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::px;

    #[test]
    fn a_position_laid_out_in_device_pixels_settles_on_them() {
        for scale in [1.25, 1.5, 1.75, 3., 1.1, 2.5] {
            let grid = Grid::new(scale);
            // Where it lands in the window, and how far its scroll view is
            // scrolled: its place in the layout is that much further down.
            for at in [0., 1., 7., 333., 2047., 4095., 8191.] {
                for offset in [0., -1., -40., -1_000., -99_999., -999_999.] {
                    let device = at - offset;
                    // The offset as a scroll view gives it: logical.
                    let placed = grid.place(device, px(offset / scale));
                    let (settled, on) = grid.settle(placed.0 * scale);
                    assert_eq!(settled, at, "{scale} {at} {offset}");
                    assert!(on, "{scale} {at} {offset}");
                    assert_eq!(grid.settle_logical(placed), (placed, true));
                    // Moved, it is where laying it out there puts it.
                    let moved = grid.moved(placed, 13.);
                    assert_eq!(moved, grid.place(device + 13., px(offset / scale)));
                }
            }
        }
    }

    #[test]
    fn a_distance_snaps_to_the_grid_only_where_it_is_off_it() {
        let grid = Grid::new(1.1);
        assert_eq!(grid.snap_distance(1.1), 1.125);
        assert_eq!(grid.snap_distance(-2.2), -2.25);
        for scale in [1.25, 1.5, 1.75, 3.] {
            let grid = Grid::new(scale);
            for logical in [1., 2., -1., 4., 0.5] {
                assert_eq!(grid.snap_distance(logical * scale), logical * scale);
            }
        }
        assert_eq!(Grid::new(2.).snap_distance(2.2), 2.2);
        // Up, never less: a border's band still holds the border.
        let grid = Grid::new(1.1);
        assert_eq!(grid.snap_up(6. * 1.1), 6.625);
        assert_eq!(grid.snap_up(3. * 1.1), 3.375);
        assert_eq!(Grid::new(1.25).snap_up(6. * 1.25), 7.5);
        assert_eq!(Grid::new(1.).snap_up(6.3), 6.3);
    }

    #[test]
    fn a_power_of_two_settles_nothing() {
        for scale in [1., 2., 4., 0.5] {
            let grid = Grid::new(scale);
            assert_eq!(grid.settle(10.001), (10.001, false));
            assert_eq!(grid.settle(10.125), (10.125, true));
            assert_eq!(grid.settle_logical(px(3.3)), (px(3.3), false));
            assert_eq!(grid.place(40., px(-3.3)), px(40. / scale) + px(-3.3));
            assert_eq!(grid.moved(px(3.3), 4.), px(3.3) + px(4. / scale));
        }
    }

    #[test]
    fn a_move_is_whole_only_between_grid_points() {
        let grid = Grid::new(1.5);
        let at = |device: f32| point(px(0.), px(device / 1.5));
        assert_eq!(grid.whole_move(at(10.), at(53.)), Some(point(0., 43.)));
        assert_eq!(grid.whole_move(at(10.5), at(53.5)), Some(point(0., 43.)));
        assert_eq!(grid.whole_move(at(10.), at(53.5)), None);
        assert_eq!(grid.whole_move(at(10.3), at(53.3)), None);
        let grid = Grid::new(1.);
        let at = |device: f32| point(px(0.), px(device));
        assert_eq!(grid.whole_move(at(10.), at(11.)), Some(point(0., 1.)));
        assert_eq!(grid.whole_move(at(10.5), at(11.5)), Some(point(0., 1.)));
        assert_eq!(grid.whole_move(at(10.), at(10.5)), None);
        assert_eq!(grid.whole_move(at(10.3), at(11.3)), None);
    }
}
