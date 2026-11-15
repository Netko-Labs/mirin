//! mirin: the device grid at any scale factor (`docs/metal/gpui-next.md`,
//! "Round 6"; the fork's `../gpui/src/elements/retained/grid.rs` in spirit).
//!
//! Upstream lays out and snaps in device pixels, then hands elements
//! logical bounds (device pixels divided by the scale factor), which every
//! primitive multiplies back. At a power of two that is exact, so a drawing
//! copied a whole number of device pixels away is what drawing it there
//! gives. At 1.25, 1.5 or 1.75 it is not: an edge of 41 device pixels comes
//! back as 41.000004 or 40.999996, so a content mask's `ceil` can take the
//! pixel after it in one place and not in another, and a hitbox moved by
//! `by / scale` differs in its last bits from one laid out there. So where
//! scaling is not exact:
//!
//! - a device position within [`SNAP`] of a whole pixel is that pixel
//!   before it is floored or ceiled ([`Grid::settle`]: every content mask
//!   and shadow, with or without retained subtrees, so a drawing is the
//!   same either way);
//! - a node's origin is its device position and the element offset divided
//!   once (`Window::layout_bounds`), as a moved position is;
//! - a logical position on the grid (within [`ON_GRID`] of a whole device
//!   pixel) is moved through its device position ([`Grid::moved`]), and one
//!   off it keeps its subtree from moving along that axis.
//!
//! At a power of two nothing changes: every value is what it was.

use crate::{Bounds, Pixels, Point, px};

/// How close to a whole device pixel a device position is taken for it
/// where scaling is not exact.
pub(crate) const SNAP: f32 = 1. / 256.;
/// How close to a whole device pixel a position must be to be moved on the
/// grid: well inside [`SNAP`], and past what `f32` loses dividing a whole
/// pixel by the scale factor and multiplying it back below [`ON_GRID_BELOW`].
pub(crate) const ON_GRID: f32 = 1. / 512.;
/// Device positions this far out lose too much to be told on the grid.
const ON_GRID_BELOW: f32 = 16384.;

/// Whether `scale` scales exactly (a power of two).
pub(crate) fn is_exact_scale(scale: f32) -> bool {
    scale > 0. && scale.log2().fract() == 0.
}

/// The device grid of a scale factor.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Grid {
    scale: f32,
    exact: bool,
}

impl Grid {
    pub(crate) fn new(scale: f32) -> Self {
        Self {
            scale,
            exact: is_exact_scale(scale),
        }
    }

    /// Whether scaling is exact here (nothing is settled or moved through
    /// device positions).
    pub(crate) fn is_exact(&self) -> bool {
        self.exact
    }

    /// A device position about to be floored or ceiled: the whole pixel it
    /// is within [`SNAP`] of, where scaling is not exact.
    pub(crate) fn settle(&self, device: f32) -> f32 {
        if self.exact {
            return device;
        }
        let whole = device.round();
        if (device - whole).abs() <= SNAP {
            whole
        } else {
            device
        }
    }

    /// Whether a logical position moves exactly through its device position.
    pub(crate) fn is_on(&self, logical: Pixels) -> bool {
        is_on_grid(logical.0 * self.scale)
    }

    /// A logical position `by` device pixels (whole ones) on, as laying it
    /// out there gives: added where scaling is exact, through its device
    /// position otherwise (it must be on the grid, `is_on`).
    pub(crate) fn moved(&self, logical: Pixels, by: f32) -> Pixels {
        if by == 0. {
            logical
        } else if self.exact {
            logical + px(by / self.scale)
        } else {
            px(((logical.0 * self.scale).round() + by) / self.scale)
        }
    }

    pub(crate) fn moved_point(&self, point: Point<Pixels>, by: Point<f32>) -> Point<Pixels> {
        Point {
            x: self.moved(point.x, by.x),
            y: self.moved(point.y, by.y),
        }
    }

    /// `bounds` moved as a whole: its origin, its size as it is.
    pub(crate) fn moved_bounds(&self, bounds: Bounds<Pixels>, by: Point<f32>) -> Bounds<Pixels> {
        Bounds {
            origin: self.moved_point(bounds.origin, by),
            size: bounds.size,
        }
    }
}

/// Whether a device position computed from a whole device pixel through a
/// scale factor that is not exact is told from it ([`ON_GRID`]).
pub(crate) fn is_on_grid(device: f32) -> bool {
    device.abs() < ON_GRID_BELOW && (device - device.round()).abs() <= ON_GRID
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::point;

    #[test]
    fn a_whole_pixel_divided_and_multiplied_back_settles_on_itself() {
        for scale in [1.25_f32, 1.5, 1.75, 3., 1.1] {
            let grid = Grid::new(scale);
            for device in 0..12000 {
                let logical = device as f32 / scale;
                let back = logical * scale;
                assert_eq!(grid.settle(back), device as f32, "{device} at {scale}");
                assert!(is_on_grid(back), "{device} at {scale}: {back}");
            }
        }
    }

    #[test]
    fn a_moved_position_is_the_one_laid_out_there() {
        let grid = Grid::new(1.5);
        for (from, by) in [(41., 60.), (7., -3.), (1000., 1.), (13., 0.)] {
            let laid_out = px((from + by) / 1.5);
            assert_eq!(grid.moved(px(from / 1.5), by), laid_out);
        }
        // Nothing moves where it is exact, or where it does not move.
        let exact = Grid::new(2.);
        assert_eq!(exact.moved(px(10.25), 3.), px(11.75));
        assert_eq!(exact.settle(41.000004), 41.000004);
        let off = px(10.3);
        assert_eq!(grid.moved_point(point(off, off), point(0., 3.)).x, off);
    }
}
