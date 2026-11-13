//! mirin: what a retained subtree drawn anew records about its drawing, so
//! a later frame can tell whether the same drawing, moved, is what drawing
//! it again would give.
//!
//! Three things decide that, and each is tracked while the subtree draws:
//!
//! - Content masks. A primitive or hitbox keeps the mask it was drawn
//!   under, already intersected with every mask around it. Moved, the masks
//!   pushed inside the subtree move along and the ones around it don't, so
//!   the frame keeps every mask as it was given, with the one around it;
//!   a moved drawing's masks are worked out again from those (`masks`).
//! - What was left out. Elements skip what their content mask hides
//!   (glyphs, primitives). While a subtree is drawn anew they cull against a
//!   region around its mask instead (`Window::cull_mask`), and a primitive
//!   that is hidden but inside the region is kept as a paint operation. What
//!   is left out all the same narrows where the drawing is whole
//!   ([`Recording::valid`]).
//! - Positions that round. A glyph of a line is placed across from the
//!   line's position on the grid and its own distance from it apart
//!   (`place_glyph_x`), so a line moved by whole device pixels draws the
//!   same pixels there; down, it snaps to a pixel from its own position, so
//!   a subtree is not moved down when a glyph sits within rounding of a
//!   pixel edge.
//!   Everything else is settled on the device grid (`grid`), and what is
//!   off it keeps the subtree where it is along that axis.

use std::rc::Rc;

use crate::{
    Bounds, Pixels, Point, ScaledPixels, TransformationMatrix, Window, point, px,
    scene::{Inserted, Primitive},
    size,
};

use super::{RetainedRecord, grid::Grid, masks::MaskNode, region::Region};

/// How far past its content mask a subtree drawn anew keeps what it draws
/// (hidden): one scrolled into view by less than this is whole already.
const KEEP_MARGIN: Pixels = px(256.);

/// Past this (device pixels) a grid point plus a whole move may not be
/// exact in `f32`: a glyph's line there pins its subtree across.
const GLYPH_FAR: f32 = 524_288.;

/// Where a glyph is painted across: the device pixel its raster is placed
/// from, and which of its subpixel variants is drawn.
pub(crate) struct PlacedGlyphX {
    pub(crate) pixel: ScaledPixels,
    pub(crate) variant: u8,
}

/// How close to a pixel edge a glyph's position may be for the pixel it
/// snaps to not to depend on rounding: far more than `f32` loses at any
/// position a window has.
const EDGE: f32 = 1. / 128.;

/// What a retained subtree being drawn anew has recorded so far. It is
/// started in prepaint and carried on in paint.
pub(crate) struct Recording {
    /// The content mask around the subtree, and its place in the frame's
    /// list in the phase being drawn.
    mask: Bounds<Pixels>,
    mask_id: u32,
    /// Where its drawing is whole: what was left out lies outside.
    pub(crate) valid: Region,
    /// Everything it draws, shown or not; `None` while nothing.
    pub(crate) extent: Option<Bounds<Pixels>>,
    /// Every retained subtree inside, at any depth.
    pub(crate) nested: Vec<Rc<RetainedRecord>>,
    /// Its drawing can't be moved: something in it knows where it is.
    pub(crate) pinned: bool,
    /// Its drawing can't be moved across, or down: it has glyphs, which
    /// snap to a fraction of a pixel across; a glyph sits so close to a
    /// pixel edge that where it snaps to depends on rounding; or a
    /// primitive, hitbox or mask is off the device grid (`Grid`).
    pub(crate) fixed: [bool; 2],
    /// It can't be left undrawn: something in it lives outside its drawing.
    pub(crate) stays: bool,
    /// A subtree inside was drawn though nothing of it shows: drawing this
    /// one again would leave it out.
    pub(crate) prunable: bool,
}

impl Recording {
    /// How far the subtree reaches: `bounds` is drawn (or would be).
    pub(crate) fn reach(&mut self, bounds: Bounds<Pixels>) {
        self.extent = Some(match self.extent {
            Some(extent) => extent.union(&bounds),
            None => bounds,
        });
    }

    /// Take in a retained subtree inside this one, drawn or not. `local`
    /// is what the masks pushed between the two clip to (`None`: no mask).
    pub(crate) fn absorb(&mut self, child: &super::Drawn, local: Option<Bounds<Pixels>>) {
        if let Some(extent) = child.extent {
            self.reach(extent);
        }
        self.pinned |= child.pinned;
        self.fixed[0] |= child.fixed[0];
        self.fixed[1] |= child.fixed[1];
        self.stays |= !child.inert;
        self.prunable |= child.prunable;
        if child.ranges.is_none() {
            // Left undrawn: this drawing has a hole where it would show.
            let shown = child.extent.map(|extent| match local {
                Some(local) => extent.intersect(&local),
                None => extent,
            });
            if let Some(shown) = shown.filter(|shown| !shown.is_empty()) {
                self.valid.leave_out(&shown, &self.mask);
            }
        } else if !child.valid.is_everywhere()
            && !local.is_some_and(|local| child.valid.covers(&local))
        {
            // Not whole everywhere, and no mask in between hides the rest.
            self.valid.intersect(&child.valid);
        }
    }
}

impl Window {
    /// A content mask is pushed: keep it as given (`MaskNode`). Returns
    /// whether a cull region was pushed with it (`pop_mask_node`).
    pub(crate) fn push_mask_node(&mut self, bounds: Bounds<Pixels>) -> bool {
        let parent = self.mask_id_stack.last().copied().unwrap_or(0);
        self.next_frame
            .content_masks
            .push(MaskNode { bounds, parent });
        let id = self.next_frame.content_masks.len() as u32;
        self.mask_id_stack.push(id);
        self.next_frame.scene.mask_id = id;
        let Some(cull) = self.cull_stack.last() else {
            return false;
        };
        let cull = cull.intersect(&bounds);
        self.cull_stack.push(cull);
        self.next_frame.scene.keep = Some(cull.scale(self.scale_factor()));
        true
    }

    pub(crate) fn pop_mask_node(&mut self, culls: bool) {
        self.mask_id_stack.pop();
        self.next_frame.scene.mask_id = self.mask_id_stack.last().copied().unwrap_or(0);
        if culls {
            self.cull_stack.pop();
            self.set_scene_keep();
        }
    }

    fn set_scene_keep(&mut self) {
        let scale_factor = self.scale_factor();
        self.next_frame.scene.keep = self.cull_stack.last().map(|cull| cull.scale(scale_factor));
    }

    /// What an element culls against: the content mask, or, while a
    /// retained subtree is drawn anew, a region around its mask (clipped by
    /// the masks pushed inside it), so its drawing is whole when it moves.
    /// What is left out all the same is reported with `record_left_out`.
    pub(crate) fn cull_mask(&self) -> Bounds<Pixels> {
        match self.cull_stack.last() {
            Some(cull) => *cull,
            None => self.content_mask().bounds,
        }
    }

    /// Start (prepaint) or carry on (paint, with what prepaint recorded)
    /// recording the retained subtree about to be drawn anew.
    pub(crate) fn begin_recording(&mut self, carried: Option<Recording>) {
        let mask = self.content_mask().bounds;
        let mask_id = self.mask_id_stack.last().copied().unwrap_or(0);
        let recording = match carried {
            Some(recording) => Recording {
                mask,
                mask_id,
                ..recording
            },
            None => Recording {
                mask,
                mask_id,
                valid: Region::everywhere(),
                extent: None,
                nested: Vec::new(),
                pinned: false,
                fixed: [false; 2],
                stays: false,
                prunable: false,
            },
        };
        self.recordings.push(recording);
        self.cull_stack.push(mask.dilate(KEEP_MARGIN));
        self.set_scene_keep();
    }

    pub(crate) fn end_recording(&mut self) -> Recording {
        self.cull_stack.pop();
        self.set_scene_keep();
        self.recordings
            .pop()
            .expect("a recording ends where it began")
    }

    /// Take a retained subtree inside the one being recorded (if one is)
    /// into its recording. Called where the inner subtree sits, so the masks
    /// pushed since the outer one began are the ones between the two.
    pub(crate) fn absorb_retained(
        &mut self,
        record: &Rc<RetainedRecord>,
        nested: &[Rc<RetainedRecord>],
        unseen: bool,
    ) {
        let Some(recording) = self.recordings.last_mut() else {
            return;
        };
        let masks = &self.next_frame.content_masks;
        let mut id = self.mask_id_stack.last().copied().unwrap_or(0);
        let mut local: Option<Bounds<Pixels>> = None;
        while id != recording.mask_id && id != 0 {
            let node = masks[id as usize - 1];
            local = Some(local.map_or(node.bounds, |local| local.intersect(&node.bounds)));
            id = node.parent;
        }
        recording.absorb(&record.drawn.borrow(), local);
        // `unseen`: it was drawn though nothing of it shows.
        recording.prunable |= unseen;
        recording.nested.push(record.clone());
        recording.nested.extend(nested.iter().cloned());
    }

    /// Put a primitive in the scene. While a retained subtree is drawn anew
    /// it counts toward how far the subtree reaches, and one left out
    /// narrows where its drawing is whole.
    pub(crate) fn insert_primitive(&mut self, primitive: impl Into<Primitive>) {
        let mut primitive = primitive.into();
        let grid = self.grid();
        if self.recordings.is_empty() && grid.is_exact() {
            self.next_frame.scene.insert_primitive(primitive);
            return;
        }
        // Settled whether or not anything is recorded: a drawing is the
        // same with retained subtrees and without.
        let on = primitive.settle(&grid);
        if self.recordings.is_empty() {
            self.next_frame.scene.insert_primitive(primitive);
            return;
        }
        self.record_off_grid(on);
        let scale_factor = self.scale_factor();
        let scaled = *primitive.bounds();
        let bounds = Bounds {
            origin: point(
                px(scaled.origin.x.0 / scale_factor),
                px(scaled.origin.y.0 / scale_factor),
            ),
            size: size(
                px(scaled.size.width.0 / scale_factor),
                px(scaled.size.height.0 / scale_factor),
            ),
        };
        if self.next_frame.scene.insert_primitive(primitive) == Inserted::Dropped {
            self.record_left_out(bounds);
        } else if let Some(recording) = self.recordings.last_mut() {
            recording.reach(bounds);
        }
    }

    /// Something at `bounds` was not drawn because nothing of it shows
    /// (`cull_mask`). For each retained subtree being drawn anew whose own
    /// masks don't hide it (those move with it), its drawing has a hole
    /// there.
    pub(crate) fn record_left_out(&mut self, bounds: Bounds<Pixels>) {
        let Some(recording) = self.recordings.last_mut() else {
            return;
        };
        recording.reach(bounds);
        let masks = &self.next_frame.content_masks;
        let mut id = self.mask_id_stack.last().copied().unwrap_or(0);
        let mut local: Option<Bounds<Pixels>> = None;
        for recording in self.recordings.iter_mut().rev() {
            while id != recording.mask_id && id != 0 {
                let node = masks[id as usize - 1];
                local = Some(local.map_or(node.bounds, |local| local.intersect(&node.bounds)));
                id = node.parent;
            }
            let shown = match local {
                Some(local) => bounds.intersect(&local),
                None => bounds,
            };
            if shown.is_empty() {
                // Hidden by a mask inside this subtree, and so inside the
                // ones around it: it stays hidden wherever they go.
                break;
            }
            recording.valid.leave_out(&shown, &recording.mask);
        }
    }

    /// A glyph is painted at `origin`, in device pixels: whether it lands
    /// on the same pixel down wherever it is moved to.
    pub(crate) fn record_glyph(&mut self, origin: Point<ScaledPixels>) {
        let Some(recording) = self.recordings.last_mut() else {
            return;
        };
        // Down, it snaps to a pixel (or a fraction, off Linux and Windows).
        let down = (origin.y.0 * crate::SUBPIXEL_VARIANTS_Y as f32)
            .fract()
            .abs();
        if down != 0. && !(EDGE..=1. - EDGE).contains(&down) {
            recording.fixed[1] = true;
        }
    }

    /// A glyph painted from its own position across (`paint_glyph`): it
    /// snaps to a fraction of a pixel from a position that is rarely exact,
    /// so the retained subtree being drawn anew is never moved across.
    pub(crate) fn pin_glyph_across(&mut self) {
        if let Some(recording) = self.recordings.last_mut() {
            recording.fixed[0] = true;
        }
    }

    /// The pixel and subpixel position across of a glyph `offset` (logical)
    /// from the start of a line at `line_x`. The line's device position is
    /// settled on the grid, and the glyph's distance from it is added to its
    /// fraction alone, so a line moved a whole number of device pixels puts
    /// each glyph exactly that much further, on the same subpixel position.
    /// A line off the grid (or past where a grid point plus a whole move
    /// stays exact) keeps the retained subtree being drawn anew from moving
    /// across.
    pub(crate) fn place_glyph_x(&mut self, line_x: Pixels, offset: Pixels) -> PlacedGlyphX {
        let (placed, steady) = glyph_x(&self.grid(), self.scale_factor(), line_x, offset);
        if !steady {
            self.pin_glyph_across();
        }
        placed
    }

    /// Something drawn is on the device grid across and down, or not
    /// (`Grid`): off it, the retained subtree being drawn anew is not moved
    /// along that axis.
    pub(crate) fn record_off_grid(&mut self, on: [bool; 2]) {
        if let Some(recording) = self.recordings.last_mut() {
            recording.fixed[0] |= !on[0];
            recording.fixed[1] |= !on[1];
        }
    }

    /// The pixel an icon with its top left at `origin` (device pixels) is
    /// painted from. One the same drawing moved would not land on the same
    /// way pins the retained subtree being drawn anew.
    pub(crate) fn svg_origin(
        &mut self,
        origin: Point<ScaledPixels>,
        transformation: &TransformationMatrix,
    ) -> Point<ScaledPixels> {
        let grid = self.grid();
        // Where scaling is exact, as upstream: a half pixel rounds away
        // from zero, not the same way wherever it is. Elsewhere halves are
        // common (a logical pixel is a pixel and a half) and positions
        // carry what `f32` lost: settled first, and a half always rounds
        // up, wherever it is; only one off the grid and next to a half
        // could land either way.
        let round = |value: ScaledPixels| {
            if grid.is_exact() {
                return (value.round(), value.0.fract().abs() != 0.5);
            }
            let (settled, on) = grid.settle(value.0);
            let from_half = ((settled - settled.floor()) - 0.5).abs();
            (
                ScaledPixels((settled + 0.5).floor()),
                on || from_half > EDGE,
            )
        };
        let ((x, steady_x), (y, steady_y)) = (round(origin.x), round(origin.y));
        // A rotation is about a point of the window.
        if *transformation != TransformationMatrix::unit() || !steady_x || !steady_y {
            self.pin_recordings(false);
        }
        point(x, y)
    }

    /// Something in the retained subtree being drawn anew knows where it is
    /// in the window, so its drawing is never moved; `stays`: and it lives
    /// outside the drawing, so the subtree is never left undrawn.
    pub(crate) fn pin_recordings(&mut self, stays: bool) {
        if let Some(recording) = self.recordings.last_mut() {
            recording.pinned = true;
            recording.stays |= stays;
        }
    }
}

/// `Window::place_glyph_x` at scale factor `scale`, and whether the line is
/// on the grid (where a whole move puts each glyph exactly that far).
fn glyph_x(grid: &Grid, scale: f32, line_x: Pixels, offset: Pixels) -> (PlacedGlyphX, bool) {
    let (line, on) = grid.settle(line_x.0 * scale);
    let pixel = line.floor();
    let within = (line - pixel) + offset.0 * scale;
    let whole = within.floor();
    let placed = PlacedGlyphX {
        pixel: ScaledPixels(pixel + whole),
        variant: ((within - whole) * crate::SUBPIXEL_VARIANTS_X as f32).floor() as u8,
    };
    (placed, on && line.abs() < GLYPH_FAR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glyph_moved_by_whole_device_pixels_lands_on_the_same_subpixel_position() {
        let mut before = 0;
        for scale in [1.0, 2.0, 1.25, 1.5, 1.75, 3.0] {
            let grid = Grid::new(scale);
            for at in (0..4000).step_by(37) {
                // Where layout puts a line: a device position, in a scroll
                // view scrolled some way.
                let line_x = grid.place(at as f32 + 0.125 * (at % 8) as f32, px(-50.0 / scale));
                for by in [1.0, 3.0, 40.0, 333.0, -7.0, 1999.0] {
                    let moved = grid.moved(line_x, by);
                    for step in 0..60 {
                        let offset = px(step as f32 * 3.17 + 0.013);
                        let (here, steady) = glyph_x(&grid, scale, line_x, offset);
                        let (there, _) = glyph_x(&grid, scale, moved, offset);
                        assert!(steady);
                        assert_eq!(there.pixel.0, here.pixel.0 + by, "{scale} {at} {by}");
                        assert_eq!(there.variant, here.variant, "{scale} {at} {by}");
                        // Placed from where it is in the window, as GPUI
                        // did, it lands elsewhere now and then.
                        let old = |line_x: Pixels| {
                            let x = (line_x.0 + offset.0) * scale;
                            (x.floor(), (x.fract() * 4.0).floor())
                        };
                        let (old_here, old_there) = (old(line_x), old(moved));
                        if old_there != (old_here.0 + by, old_here.1) {
                            before += 1;
                        }
                    }
                }
            }
        }
        assert!(before > 0);
    }
}
