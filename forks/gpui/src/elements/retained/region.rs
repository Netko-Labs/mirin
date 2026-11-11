//! mirin: where a retained subtree's drawing is whole.

use crate::{Bounds, Pixels, Point};

/// A region of the window, by its edges. `Region::everywhere` stands for
/// no limit.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Region {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

/// Far past any window, and exact in `f32` however it is moved.
const FAR: f32 = 4_000_000.;

impl Region {
    pub(crate) const fn everywhere() -> Self {
        Self {
            left: -FAR,
            top: -FAR,
            right: FAR,
            bottom: FAR,
        }
    }

    pub(crate) fn is_everywhere(&self) -> bool {
        *self == Self::everywhere()
    }

    fn of(bounds: &Bounds<Pixels>) -> Self {
        Self {
            left: bounds.left().0,
            top: bounds.top().0,
            right: bounds.right().0,
            bottom: bounds.bottom().0,
        }
    }

    pub(crate) fn moved(&self, by: Point<Pixels>) -> Self {
        if self.is_everywhere() {
            return *self;
        }
        Self {
            left: self.left + by.x.0,
            top: self.top + by.y.0,
            right: self.right + by.x.0,
            bottom: self.bottom + by.y.0,
        }
    }

    /// Whether `outer` holds all of `inner`.
    pub(crate) fn holds(outer: &Bounds<Pixels>, inner: &Bounds<Pixels>) -> bool {
        Self::of(outer).covers(inner)
    }

    pub(crate) fn covers(&self, bounds: &Bounds<Pixels>) -> bool {
        let other = Self::of(bounds);
        self.left <= other.left
            && self.top <= other.top
            && self.right >= other.right
            && self.bottom >= other.bottom
    }

    pub(super) fn intersect(&mut self, other: &Self) {
        self.left = self.left.max(other.left);
        self.top = self.top.max(other.top);
        self.right = self.right.min(other.right);
        self.bottom = self.bottom.min(other.bottom);
    }

    /// Narrow the region so it leaves `hole` out, keeping `mask` (which
    /// `hole` lies outside of) in: cut on the side where `hole` is farthest
    /// from `mask`.
    pub(super) fn leave_out(&mut self, hole: &Bounds<Pixels>, mask: &Bounds<Pixels>) {
        let (hole, mask) = (Self::of(hole), Self::of(mask));
        let gaps = [
            mask.top - hole.bottom,
            hole.top - mask.bottom,
            mask.left - hole.right,
            hole.left - mask.right,
        ];
        let side = (0..4)
            .max_by(|a, b| gaps[*a].total_cmp(&gaps[*b]))
            .unwrap_or(0);
        if gaps[side] < 0. {
            // Not outside the mask after all: whole only where it was drawn.
            self.intersect(&mask);
            return;
        }
        match side {
            0 => self.top = self.top.max(hole.bottom),
            1 => self.bottom = self.bottom.min(hole.top),
            2 => self.left = self.left.max(hole.right),
            _ => self.right = self.right.min(hole.left),
        }
    }
}
