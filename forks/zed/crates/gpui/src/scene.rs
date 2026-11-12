// todo("windows"): remove
#![cfg_attr(windows, allow(dead_code))]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AtlasTextureId, AtlasTile, Background, Bounds, ContentMask, Corners, Edges, Hsla, Pixels,
    Point, Radians, ScaledPixels, Size, bounds_tree::BoundsTree, elements::MaskMap, point,
    window::MaskId,
};
use std::{
    fmt::Debug,
    iter::Peekable,
    ops::{Add, Range, Sub},
    slice,
};

#[allow(non_camel_case_types, unused)]
#[expect(missing_docs)]
pub type PathVertex_ScaledPixels = PathVertex<ScaledPixels>;

#[expect(missing_docs)]
pub type DrawOrder = u32;

/// A boolean stored as a `u32` so that GPU-facing structs contain no
/// compiler-inserted padding bytes, which would be undefined behavior to
/// reinterpret as `&[u8]` when writing instance buffers. Guaranteed to be
/// `0` or `1` by construction; shaders read it as a `u32`/`uint`.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
#[repr(transparent)]
pub struct PaddedBool32(u32);

impl From<bool> for PaddedBool32 {
    fn from(value: bool) -> Self {
        PaddedBool32(value as u32)
    }
}

#[derive(Default)]
#[expect(missing_docs)]
pub struct Scene {
    pub(crate) paint_operations: Vec<PaintOperation>,
    primitive_bounds: BoundsTree<ScaledPixels>,
    layer_stack: Vec<DrawOrder>,
    pub shadows: Vec<Shadow>,
    pub quads: Vec<Quad>,
    pub paths: Vec<Path<ScaledPixels>>,
    pub underlines: Vec<Underline>,
    pub monochrome_sprites: Vec<MonochromeSprite>,
    pub subpixel_sprites: Vec<SubpixelSprite>,
    pub polychrome_sprites: Vec<PolychromeSprite>,
    pub surfaces: Vec<PaintSurface>,
    /// mirin: while a retained subtree is drawn anew, how far what it puts
    /// in the scene reaches (`elements::retained`).
    pub(crate) reach: Option<SceneReach>,
    /// mirin: the content mask the window is drawing under, as given
    /// (`MaskNode`): every operation keeps it, for the mask map.
    pub(crate) mask_id: MaskId,
}

/// mirin: what a retained subtree being drawn anew put in the scene: every
/// primitive's bounds, shown or not, and whether one knows where it is (a
/// path, a transformed sprite) so the drawing can't be moved.
/// Of a primitive under a mask pushed inside the subtree, only what that
/// mask lets through counts (the mask moves with it); under the mask around
/// the subtree (`outer`), all of it. A primitive the mask around it hides
/// is kept in the drawing (not shown) within `keep` of it, so the drawing
/// moved where it shows is whole; past that it is left out (`left_out`).
#[derive(Clone)]
pub(crate) struct SceneReach {
    pub(crate) extent: Option<Bounds<ScaledPixels>>,
    pub(crate) left_out: Option<Bounds<ScaledPixels>>,
    pub(crate) pinned: bool,
    outer: ContentMask<ScaledPixels>,
    keep: Bounds<ScaledPixels>,
    /// What the masks pushed inside the subtree let through where the
    /// window draws now, without the one around it (`Window::own_mask`);
    /// `None` under that one.
    pub(crate) own: Option<Bounds<ScaledPixels>>,
}

fn union(into: &mut Option<Bounds<ScaledPixels>>, bounds: Bounds<ScaledPixels>) {
    *into = Some(match *into {
        Some(extent) => extent.union(&bounds),
        None => bounds,
    });
}

impl SceneReach {
    pub(crate) fn new(outer: ContentMask<ScaledPixels>, keep: Bounds<ScaledPixels>) -> Self {
        Self {
            extent: None,
            left_out: None,
            pinned: false,
            outer,
            keep,
            own: None,
        }
    }

    /// What of a primitive drawn now (a border's strip with `strip`) the
    /// masks pushed inside the subtree let through: how far it reaches, and
    /// what of it the mask around it hides. Empty: those masks hide it,
    /// wherever the subtree is copied.
    fn own_reach(&self, primitive: &Primitive, strip: Option<&Strip>) -> Bounds<ScaledPixels> {
        let mut bounds = *primitive.bounds();
        if let Some(strip) = strip {
            bounds = bounds.intersect(&strip.bounds);
        }
        match self.own {
            Some(own) => bounds.intersect(&own),
            None => bounds,
        }
    }

    /// A primitive drawn now that the mask around the subtree hides: kept
    /// (unshown) near it, so the drawing moved where it shows is whole, or
    /// left out past that.
    fn keeps(&mut self, primitive: &Primitive, strip: Option<&Strip>) -> bool {
        let reach = self.own_reach(primitive, strip);
        if reach.is_empty() {
            return false;
        }
        if reach.intersects(&self.keep) {
            return true;
        }
        union(&mut self.left_out, reach);
        false
    }

    /// A primitive drawn now (`fresh`), or copied from a drawing inside the
    /// subtree (whose own record says how far it reaches), reaches this far.
    fn take_in(&mut self, primitive: &Primitive, strip: Option<&Strip>, fresh: bool) {
        let bounds = if fresh {
            self.own_reach(primitive, strip)
        } else {
            let mask = strip.map_or(primitive.content_mask(), |strip| &strip.mask);
            let mut bounds = *primitive.bounds();
            if let Some(strip) = strip {
                bounds = bounds.intersect(&strip.bounds);
            }
            if *mask != self.outer {
                bounds = bounds.intersect(&mask.bounds);
            }
            bounds
        };
        if !bounds.is_empty() {
            union(&mut self.extent, bounds);
        }
        self.pinned |= match primitive {
            Primitive::Path(_) | Primitive::Surface(_) => true,
            Primitive::MonochromeSprite(sprite) => {
                sprite.transformation != TransformationMatrix::unit()
            }
            Primitive::SubpixelSprite(sprite) => {
                sprite.transformation != TransformationMatrix::unit()
            }
            _ => false,
        };
    }
}

/// mirin: a drawing copied (`Scene::replay_placed`): where its masks are in
/// this frame (`map`), and how far it moved, in device pixels (whole ones).
#[derive(Clone, Copy)]
pub(crate) struct Placing<'a> {
    pub(crate) map: &'a MaskMap,
    pub(crate) by: Option<Point<ScaledPixels>>,
}

impl Placing<'_> {
    /// A primitive (a border's strip with `strip`) drawn under the mask
    /// `mask_id`, copied: under that mask copied, and moved, clipped by it
    /// as it clips here (and by its strip moved).
    fn place(
        &self,
        primitive: &mut Primitive,
        strip: Option<Strip>,
        mask_id: MaskId,
    ) -> (Option<Strip>, MaskId) {
        let id = self.map.id(mask_id);
        let Some(by) = self.by else {
            return (strip, id);
        };
        let mask = self.map.cover(mask_id).clone();
        let strip = match strip {
            Some(strip) => {
                let strip = Strip {
                    bounds: strip.bounds + by,
                    mask,
                };
                let content_mask = ContentMask {
                    bounds: strip.mask.bounds.intersect(&strip.bounds),
                };
                primitive.move_by(by, content_mask);
                Some(strip)
            }
            None => {
                primitive.move_by(by, mask);
                None
            }
        };
        (strip, id)
    }

    /// What of a primitive shows once copied (without copying it).
    fn shown(
        &self,
        primitive: &Primitive,
        strip: Option<&Strip>,
        mask_id: MaskId,
    ) -> Bounds<ScaledPixels> {
        let Some(by) = self.by else {
            return primitive
                .bounds()
                .intersect(&primitive.content_mask().bounds);
        };
        let shown = (*primitive.bounds() + by).intersect(&self.map.cover(mask_id).bounds);
        match strip {
            Some(strip) => shown.intersect(&(strip.bounds + by)),
            None => shown,
        }
    }

    /// A layer's bounds, unclipped bounds, mask and mask's place, copied.
    fn layer(
        &self,
        bounds: &Bounds<ScaledPixels>,
        unclipped: &Bounds<ScaledPixels>,
        mask: &ContentMask<ScaledPixels>,
        mask_id: MaskId,
    ) -> (
        Bounds<ScaledPixels>,
        Bounds<ScaledPixels>,
        ContentMask<ScaledPixels>,
        MaskId,
    ) {
        let id = self.map.id(mask_id);
        let Some(by) = self.by else {
            return (*bounds, *unclipped, mask.clone(), id);
        };
        let mask = self.map.cover(mask_id).clone();
        let unclipped = *unclipped + by;
        (unclipped.intersect(&mask.bounds), unclipped, mask, id)
    }
}

#[expect(missing_docs)]
impl Scene {
    pub fn clear(&mut self) {
        self.mask_id = 0;
        self.paint_operations.clear();
        self.primitive_bounds.clear();
        self.layer_stack.clear();
        self.paths.clear();
        self.shadows.clear();
        self.quads.clear();
        self.underlines.clear();
        self.monochrome_sprites.clear();
        self.subpixel_sprites.clear();
        self.polychrome_sprites.clear();
        self.surfaces.clear();
    }

    pub fn len(&self) -> usize {
        self.paint_operations.len()
    }

    pub fn push_layer(&mut self, bounds: Bounds<ScaledPixels>) {
        self.push_layer_within(bounds, bounds, ContentMask { bounds }, self.mask_id);
    }

    /// mirin: `push_layer`, keeping the layer's bounds before its content
    /// mask clipped them, and that mask, so a retained subtree's drawing
    /// copied elsewhere clips it there (`replay_placed`).
    pub(crate) fn push_layer_within(
        &mut self,
        bounds: Bounds<ScaledPixels>,
        unclipped: Bounds<ScaledPixels>,
        mask: ContentMask<ScaledPixels>,
        mask_id: MaskId,
    ) {
        let order = self.primitive_bounds.insert(bounds);
        self.layer_stack.push(order);
        self.paint_operations.push(PaintOperation::StartLayer {
            bounds,
            unclipped,
            mask,
            mask_id,
        });
    }

    pub fn pop_layer(&mut self) {
        self.layer_stack.pop();
        self.paint_operations.push(PaintOperation::EndLayer);
    }

    pub fn insert_primitive(&mut self, primitive: impl Into<Primitive>) {
        self.insert_op(primitive.into(), None, self.mask_id, false);
    }

    /// mirin: one strip of a border drawn in strips (`Window::paint_quad`):
    /// `quad` under the mask it is drawn under, clipped to `strip`. The strip
    /// and that mask are kept with it, so a retained subtree's drawing
    /// copied elsewhere clips it there as drawing it there would
    /// (`Placing::place`), and while one is drawn anew a strip that mask hides
    /// is kept near it (unshown) as any primitive is.
    pub(crate) fn insert_strip(&mut self, quad: Quad, strip: Bounds<ScaledPixels>) {
        let mask = quad.content_mask;
        let content_mask = ContentMask {
            bounds: mask.bounds.intersect(&strip),
        };
        if content_mask.bounds.is_empty() && self.reach.is_none() {
            return;
        }
        let primitive = Primitive::Quad(Quad {
            content_mask,
            ..quad
        });
        self.insert_op(
            primitive,
            Some(Strip {
                bounds: strip,
                mask,
            }),
            self.mask_id,
            false,
        );
    }

    /// mirin: `insert_primitive`, for a border's strip too (`strip`), under
    /// the mask `mask_id`, and for a primitive of a copied drawing
    /// (`replayed`): one hidden stays in it (unshown), so the copy is as
    /// whole as the drawing it copies.
    fn insert_op(
        &mut self,
        mut primitive: Primitive,
        strip: Option<Strip>,
        mask_id: MaskId,
        replayed: bool,
    ) {
        let clipped_bounds = primitive
            .bounds()
            .intersect(&primitive.content_mask().bounds);

        // mirin: counted whether it shows or not; hidden near the mask
        // around a retained subtree drawn anew, kept unshown (`SceneReach`).
        if let Some(reach) = &mut self.reach {
            reach.take_in(&primitive, strip.as_ref(), !replayed);
            if clipped_bounds.is_empty() {
                if replayed || reach.keeps(&primitive, strip.as_ref()) {
                    self.paint_operations
                        .push(PaintOperation::of(primitive, strip, mask_id));
                }
                return;
            }
        }

        if clipped_bounds.is_empty() {
            if replayed {
                self.paint_operations
                    .push(PaintOperation::of(primitive, strip, mask_id));
            }
            return;
        }

        let order = self
            .layer_stack
            .last()
            .copied()
            .unwrap_or_else(|| self.primitive_bounds.insert(clipped_bounds));
        match &mut primitive {
            Primitive::Shadow(shadow) => {
                shadow.order = order;
                self.shadows.push(*shadow);
            }
            Primitive::Quad(quad) => {
                quad.order = order;
                self.quads.push(*quad);
            }
            Primitive::Path(path) => {
                path.order = order;
                path.id = PathId(self.paths.len());
                self.paths.push(path.clone());
            }
            Primitive::Underline(underline) => {
                underline.order = order;
                self.underlines.push(*underline);
            }
            Primitive::MonochromeSprite(sprite) => {
                sprite.order = order;
                self.monochrome_sprites.push(*sprite);
            }
            Primitive::SubpixelSprite(sprite) => {
                sprite.order = order;
                self.subpixel_sprites.push(*sprite);
            }
            Primitive::PolychromeSprite(sprite) => {
                sprite.order = order;
                self.polychrome_sprites.push(*sprite);
            }
            Primitive::Surface(surface) => {
                surface.order = order;
                self.surfaces.push(surface.clone());
            }
        }
        self.paint_operations
            .push(PaintOperation::of(primitive, strip, mask_id));
    }

    /// mirin: upstream's `replay`, for a drawing copied where it was or
    /// `placing.by` device pixels (whole ones) away (a retained subtree's,
    /// `elements::retained`): each primitive, strip, layer and the masks
    /// they were drawn under are copied (`MaskMap`), and when it moved each
    /// is moved and clipped by its mask as that clips here. A layer that
    /// ends up empty is not pushed (as `Window::paint_layer` would not).
    /// Only draw orders depend on layers, so what shows is the same either
    /// way.
    ///
    /// `as_one`: replayed as one where it can be (`replay_as_one`).
    pub(crate) fn replay_placed(
        &mut self,
        range: Range<usize>,
        prev_scene: &Scene,
        placing: Placing<'_>,
        as_one: bool,
    ) {
        let operations = &prev_scene.paint_operations[range];
        if as_one && self.replay_as_one(operations, placing) {
            return;
        }
        let mut pushed = Vec::new();
        for operation in operations {
            match operation {
                PaintOperation::Primitive(..) | PaintOperation::Strip(..) => {
                    let (primitive, strip, mask_id) = operation.placed(placing);
                    self.insert_op(primitive, strip, mask_id, true);
                }
                PaintOperation::StartLayer {
                    bounds,
                    unclipped,
                    mask,
                    mask_id,
                } => {
                    let (bounds, unclipped, mask, mask_id) =
                        placing.layer(bounds, unclipped, mask, *mask_id);
                    let shows = !bounds.is_empty();
                    if shows {
                        self.push_layer_within(bounds, unclipped, mask, mask_id);
                    } else {
                        // Not a layer (`Window::paint_layer` would push none),
                        // but kept in the drawing, so the drawings inside
                        // it are where they were in it.
                        self.paint_operations.push(PaintOperation::StartLayer {
                            bounds,
                            unclipped,
                            mask,
                            mask_id,
                        });
                    }
                    pushed.push(shows);
                }
                PaintOperation::EndLayer => {
                    if pushed.pop().unwrap_or(true) {
                        self.pop_layer();
                    } else {
                        self.paint_operations.push(PaintOperation::EndLayer);
                    }
                }
            }
        }
    }

    /// mirin: replay a drawing as one, when each of its primitives and
    /// layers shows where it is copied exactly when it showed where it was
    /// and nothing around it is a layer: its bounds go into the bounds tree
    /// once (`BoundsTree::insert_spanning`), as wide as what it shows, and
    /// its primitives keep their draw orders among themselves, rebased above
    /// whatever was drawn under those bounds; what is drawn over them later
    /// comes after them all. Upstream's `replay` put each primitive in the
    /// tree again to find its order: a third of a frame that copies most of
    /// the window. What overlaps is painted in the same order either way
    /// (only the numbers differ: `stacking` in the tests). Whether it was.
    fn replay_as_one(&mut self, operations: &[PaintOperation], placing: Placing<'_>) -> bool {
        if !self.layer_stack.is_empty() {
            return false;
        }
        // Where it shows, and the span of its draw orders.
        let mut unit: Option<(Bounds<ScaledPixels>, DrawOrder, DrawOrder)> = None;
        let mut show = |shown: Bounds<ScaledPixels>, order: Option<DrawOrder>| {
            unit = Some(match (unit, order) {
                (Some((bounds, first, last)), Some(order)) => {
                    (bounds.union(&shown), first.min(order), last.max(order))
                }
                (Some((bounds, first, last)), None) => (bounds.union(&shown), first, last),
                (None, order) => (shown, order.unwrap_or(DrawOrder::MAX), order.unwrap_or(0)),
            });
        };
        for operation in operations {
            let (was, now, order) = match operation {
                PaintOperation::Primitive(primitive, mask_id)
                | PaintOperation::Strip(primitive, _, mask_id) => {
                    let was = primitive
                        .bounds()
                        .intersect(&primitive.content_mask().bounds);
                    let now = placing.shown(primitive, operation.strip(), *mask_id);
                    (was, now, Some(primitive.order()))
                }
                PaintOperation::StartLayer {
                    bounds,
                    unclipped,
                    mask,
                    mask_id,
                } => {
                    let now = placing.layer(bounds, unclipped, mask, *mask_id).0;
                    (*bounds, now, None)
                }
                PaintOperation::EndLayer => continue,
            };
            if was.is_empty() != now.is_empty() {
                return false;
            }
            if !now.is_empty() {
                show(now, order);
            }
        }
        let rebase = match unit {
            Some((bounds, first, last)) if first <= last => {
                let base = self.primitive_bounds.insert_spanning(bounds, last - first);
                Some((base, first))
            }
            Some((bounds, ..)) => {
                // Layers alone, nothing in them shows.
                self.primitive_bounds.insert(bounds);
                None
            }
            None => None,
        };
        for operation in operations {
            match operation {
                PaintOperation::Primitive(..) | PaintOperation::Strip(..) => {
                    let (primitive, strip, mask_id) = operation.placed(placing);
                    if let Some(reach) = &mut self.reach {
                        reach.take_in(&primitive, strip.as_ref(), false);
                    }
                    let shows = !primitive
                        .bounds()
                        .intersect(&primitive.content_mask().bounds)
                        .is_empty();
                    match rebase {
                        Some((base, first)) if shows => {
                            let order = base + (primitive.order() - first);
                            self.push_ordered(primitive, strip, mask_id, order);
                        }
                        // Hidden as it was: kept, unshown.
                        _ => self
                            .paint_operations
                            .push(PaintOperation::of(primitive, strip, mask_id)),
                    }
                }
                PaintOperation::StartLayer {
                    bounds,
                    unclipped,
                    mask,
                    mask_id,
                } => {
                    // Its primitives carry its order already.
                    let (bounds, unclipped, mask, mask_id) =
                        placing.layer(bounds, unclipped, mask, *mask_id);
                    self.paint_operations.push(PaintOperation::StartLayer {
                        bounds,
                        unclipped,
                        mask,
                        mask_id,
                    });
                }
                PaintOperation::EndLayer => self.paint_operations.push(PaintOperation::EndLayer),
            }
        }
        true
    }

    /// mirin: put a primitive in the scene at a draw order already worked
    /// out (`replay_as_one`).
    fn push_ordered(
        &mut self,
        mut primitive: Primitive,
        strip: Option<Strip>,
        mask_id: MaskId,
        order: DrawOrder,
    ) {
        match &mut primitive {
            Primitive::Shadow(shadow) => {
                shadow.order = order;
                self.shadows.push(*shadow);
            }
            Primitive::Quad(quad) => {
                quad.order = order;
                self.quads.push(*quad);
            }
            Primitive::Path(path) => {
                path.order = order;
                path.id = PathId(self.paths.len());
                self.paths.push(path.clone());
            }
            Primitive::Underline(underline) => {
                underline.order = order;
                self.underlines.push(*underline);
            }
            Primitive::MonochromeSprite(sprite) => {
                sprite.order = order;
                self.monochrome_sprites.push(*sprite);
            }
            Primitive::SubpixelSprite(sprite) => {
                sprite.order = order;
                self.subpixel_sprites.push(*sprite);
            }
            Primitive::PolychromeSprite(sprite) => {
                sprite.order = order;
                self.polychrome_sprites.push(*sprite);
            }
            Primitive::Surface(surface) => {
                surface.order = order;
                self.surfaces.push(surface.clone());
            }
        }
        self.paint_operations
            .push(PaintOperation::of(primitive, strip, mask_id));
    }

    /// mirin: what the finished scene paints over what, whatever numbers
    /// the draw orders are: per primitive shown, what it is and the
    /// primitives painted before it that it overlaps, sorted. Two scenes
    /// with the same answer paint the same pixels (`replay_as_one`;
    /// `Window::last_scene_stacking`). Quadratic: for tests.
    pub(crate) fn stacking(&self) -> Vec<String> {
        let mut painted: Vec<Primitive> = Vec::new();
        for batch in self.batches() {
            match batch {
                PrimitiveBatch::Shadows(range) => {
                    painted.extend(self.shadows[range].iter().copied().map(Primitive::Shadow))
                }
                PrimitiveBatch::Quads(range) => {
                    painted.extend(self.quads[range].iter().copied().map(Primitive::Quad))
                }
                PrimitiveBatch::Paths(range) => {
                    painted.extend(self.paths[range].iter().cloned().map(Primitive::Path))
                }
                PrimitiveBatch::Underlines(range) => painted.extend(
                    self.underlines[range]
                        .iter()
                        .copied()
                        .map(Primitive::Underline),
                ),
                PrimitiveBatch::MonochromeSprites { range, .. } => painted.extend(
                    self.monochrome_sprites[range]
                        .iter()
                        .copied()
                        .map(Primitive::MonochromeSprite),
                ),
                PrimitiveBatch::SubpixelSprites { range, .. } => painted.extend(
                    self.subpixel_sprites[range]
                        .iter()
                        .copied()
                        .map(Primitive::SubpixelSprite),
                ),
                PrimitiveBatch::PolychromeSprites { range, .. } => painted.extend(
                    self.polychrome_sprites[range]
                        .iter()
                        .copied()
                        .map(Primitive::PolychromeSprite),
                ),
                PrimitiveBatch::Surfaces(range) => {
                    painted.extend(self.surfaces[range].iter().cloned().map(Primitive::Surface))
                }
            }
        }
        let shown = |primitive: &Primitive| {
            primitive
                .bounds()
                .intersect(&primitive.content_mask().bounds)
        };
        let mut stacking: Vec<String> = painted
            .iter()
            .enumerate()
            .map(|(index, primitive)| {
                let mut under: Vec<String> = painted[..index]
                    .iter()
                    .filter(|earlier| shown(earlier).intersects(&shown(primitive)))
                    .map(Primitive::describe)
                    .collect();
                under.sort_unstable();
                format!("{} over {under:?}", primitive.describe())
            })
            .collect();
        stacking.sort_unstable();
        stacking
    }

    pub fn finish(&mut self) {
        self.shadows.sort_by_key(|shadow| shadow.order);
        self.quads.sort_by_key(|quad| quad.order);
        self.paths.sort_by_key(|path| path.order);
        self.underlines.sort_by_key(|underline| underline.order);
        self.monochrome_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.texture_id.index));
        self.subpixel_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.texture_id.index));
        self.polychrome_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.texture_id.index));
        self.surfaces.sort_by_key(|surface| surface.order);
    }

    #[cfg_attr(
        all(
            any(target_os = "linux", target_os = "freebsd"),
            not(any(feature = "x11", feature = "wayland"))
        ),
        allow(dead_code)
    )]
    pub fn batches(&self) -> impl Iterator<Item = PrimitiveBatch> + '_ {
        BatchIterator {
            shadows_start: 0,
            shadows_iter: self.shadows.iter().peekable(),
            quads_start: 0,
            quads_iter: self.quads.iter().peekable(),
            paths_start: 0,
            paths_iter: self.paths.iter().peekable(),
            underlines_start: 0,
            underlines_iter: self.underlines.iter().peekable(),
            monochrome_sprites_start: 0,
            monochrome_sprites_iter: self.monochrome_sprites.iter().peekable(),
            subpixel_sprites_start: 0,
            subpixel_sprites_iter: self.subpixel_sprites.iter().peekable(),
            polychrome_sprites_start: 0,
            polychrome_sprites_iter: self.polychrome_sprites.iter().peekable(),
            surfaces_start: 0,
            surfaces_iter: self.surfaces.iter().peekable(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Default)]
#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
pub(crate) enum PrimitiveKind {
    Shadow,
    #[default]
    Quad,
    Path,
    Underline,
    MonochromeSprite,
    SubpixelSprite,
    PolychromeSprite,
    Surface,
}

// mirin: what a frame drew, for checks that two ways of drawing it agree.
impl Scene {
    /// Every primitive that shows (inside its content mask), described.
    pub(crate) fn describe(&self) -> Vec<String> {
        self.paint_operations
            .iter()
            .filter_map(PaintOperation::primitive)
            .filter(|primitive| {
                !primitive
                    .bounds()
                    .intersect(&primitive.content_mask().bounds)
                    .is_empty()
            })
            .map(Primitive::describe)
            .collect()
    }
}

// mirin: `Clone`, for a retained subtree's drawing parked out of a frame.
#[derive(Clone)]
pub(crate) enum PaintOperation {
    // mirin: with the mask it was drawn under, as given (`MaskNode`).
    Primitive(Primitive, MaskId),
    // mirin: a border's strip, with the strip and the mask it was drawn
    // under (`Scene::insert_strip`).
    Strip(Primitive, Strip, MaskId),
    // mirin: with the bounds before the mask clipped them, and that mask
    // (`Scene::push_layer_within`).
    StartLayer {
        bounds: Bounds<ScaledPixels>,
        unclipped: Bounds<ScaledPixels>,
        mask: ContentMask<ScaledPixels>,
        mask_id: MaskId,
    },
    EndLayer,
}

impl PaintOperation {
    /// mirin: an operation drawing `primitive` (a border's strip with
    /// `strip`) under the mask `mask_id`.
    fn of(primitive: Primitive, strip: Option<Strip>, mask_id: MaskId) -> Self {
        match strip {
            Some(strip) => Self::Strip(primitive, strip, mask_id),
            None => Self::Primitive(primitive, mask_id),
        }
    }

    /// mirin: the primitive it draws, if any.
    pub(crate) fn primitive(&self) -> Option<&Primitive> {
        match self {
            Self::Primitive(primitive, _) | Self::Strip(primitive, ..) => Some(primitive),
            _ => None,
        }
    }

    /// mirin: the border strip it draws, if it does.
    fn strip(&self) -> Option<&Strip> {
        match self {
            Self::Strip(_, strip, _) => Some(strip),
            _ => None,
        }
    }

    /// mirin: the mask it was drawn under (`MaskNode`), to renumber.
    pub(crate) fn mask_id_mut(&mut self) -> Option<&mut MaskId> {
        match self {
            Self::Primitive(_, mask_id)
            | Self::Strip(_, _, mask_id)
            | Self::StartLayer { mask_id, .. } => Some(mask_id),
            Self::EndLayer => None,
        }
    }

    /// mirin: its primitive (and strip), copied as `placing` says, and the
    /// mask it is under in this frame.
    fn placed(&self, placing: Placing<'_>) -> (Primitive, Option<Strip>, MaskId) {
        let (mut primitive, strip, mask_id) = match self {
            Self::Primitive(primitive, mask_id) => (primitive.clone(), None, *mask_id),
            Self::Strip(primitive, strip, mask_id) => (primitive.clone(), Some(*strip), *mask_id),
            _ => unreachable!("a primitive's operation"),
        };
        let (strip, mask_id) = placing.place(&mut primitive, strip, mask_id);
        (primitive, strip, mask_id)
    }
}

/// mirin: a strip of a border drawn in strips: the strip, and the content
/// mask the border was drawn under (the strip's own is both, intersected).
#[derive(Clone, Copy)]
pub(crate) struct Strip {
    bounds: Bounds<ScaledPixels>,
    mask: ContentMask<ScaledPixels>,
}

#[derive(Clone)]
#[expect(missing_docs)]
pub enum Primitive {
    Shadow(Shadow),
    Quad(Quad),
    Path(Path<ScaledPixels>),
    Underline(Underline),
    MonochromeSprite(MonochromeSprite),
    SubpixelSprite(SubpixelSprite),
    PolychromeSprite(PolychromeSprite),
    Surface(PaintSurface),
}

#[expect(missing_docs)]
impl Primitive {
    /// mirin: what is drawn, apart from its draw order and where its
    /// sprite sits in the atlas (`Window::scene_digest`).
    pub(crate) fn describe(&self) -> String {
        fn sprite(tile: &crate::AtlasTile) -> crate::AtlasTile {
            crate::AtlasTile {
                texture_id: crate::AtlasTextureId {
                    index: 0,
                    kind: tile.texture_id.kind,
                },
                tile_id: crate::TileId(0),
                padding: tile.padding,
                bounds: Bounds {
                    origin: Default::default(),
                    size: tile.bounds.size,
                },
            }
        }
        match self.clone() {
            Primitive::Shadow(mut shadow) => {
                shadow.order = 0;
                format!("{shadow:?}")
            }
            Primitive::Quad(mut quad) => {
                quad.order = 0;
                format!("{quad:?}")
            }
            Primitive::Path(mut path) => {
                path.order = 0;
                path.id = PathId(0);
                format!("{path:?}")
            }
            Primitive::Underline(mut underline) => {
                underline.order = 0;
                format!("{underline:?}")
            }
            Primitive::MonochromeSprite(mut sprite_) => {
                sprite_.order = 0;
                sprite_.tile = sprite(&sprite_.tile);
                // mirin: which subpixel variant of the glyph it is (`pad`,
                // see `Window::paint_line_glyph`), only when asked: a scene
                // described so is told from one described without it.
                if !describes_glyph_variants() {
                    sprite_.pad = 0;
                }
                format!("{sprite_:?}")
            }
            Primitive::SubpixelSprite(mut sprite_) => {
                sprite_.order = 0;
                sprite_.tile = sprite(&sprite_.tile);
                if !describes_glyph_variants() {
                    sprite_.pad = 0; // mirin: as a monochrome sprite's
                }
                format!("{sprite_:?}")
            }
            Primitive::PolychromeSprite(mut sprite_) => {
                sprite_.order = 0;
                sprite_.tile = sprite(&sprite_.tile);
                format!("{sprite_:?}")
            }
            Primitive::Surface(mut surface) => {
                surface.order = 0;
                format!("{surface:?}")
            }
        }
    }

    /// mirin: its draw order in the scene it is in (`Scene::replay_as_one`).
    pub(crate) fn order(&self) -> DrawOrder {
        match self {
            Primitive::Shadow(shadow) => shadow.order,
            Primitive::Quad(quad) => quad.order,
            Primitive::Path(path) => path.order,
            Primitive::Underline(underline) => underline.order,
            Primitive::MonochromeSprite(sprite) => sprite.order,
            Primitive::SubpixelSprite(sprite) => sprite.order,
            Primitive::PolychromeSprite(sprite) => sprite.order,
            Primitive::Surface(surface) => surface.order,
        }
    }

    pub fn bounds(&self) -> &Bounds<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.bounds,
            Primitive::Quad(quad) => &quad.bounds,
            Primitive::Path(path) => &path.bounds,
            Primitive::Underline(underline) => &underline.bounds,
            Primitive::MonochromeSprite(sprite) => &sprite.bounds,
            Primitive::SubpixelSprite(sprite) => &sprite.bounds,
            Primitive::PolychromeSprite(sprite) => &sprite.bounds,
            Primitive::Surface(surface) => &surface.bounds,
        }
    }

    /// mirin: the same primitive `by` device pixels away, under `mask`
    /// (`Scene::replay_placed`). Never a path or a surface (`SceneReach`).
    pub(crate) fn move_by(&mut self, by: Point<ScaledPixels>, mask: ContentMask<ScaledPixels>) {
        match self {
            Primitive::Shadow(shadow) => {
                shadow.bounds.origin += by;
                shadow.element_bounds.origin += by;
                shadow.content_mask = mask;
            }
            Primitive::Quad(quad) => {
                quad.bounds.origin += by;
                quad.content_mask = mask;
            }
            Primitive::Path(path) => {
                path.bounds.origin += by;
                path.content_mask = mask;
            }
            Primitive::Underline(underline) => {
                underline.bounds.origin += by;
                underline.content_mask = mask;
            }
            Primitive::MonochromeSprite(sprite) => {
                sprite.bounds.origin += by;
                sprite.content_mask = mask;
            }
            Primitive::SubpixelSprite(sprite) => {
                sprite.bounds.origin += by;
                sprite.content_mask = mask;
            }
            Primitive::PolychromeSprite(sprite) => {
                sprite.bounds.origin += by;
                sprite.content_mask = mask;
            }
            Primitive::Surface(surface) => {
                surface.bounds.origin += by;
                surface.content_mask = mask;
            }
        }
    }

    pub fn content_mask(&self) -> &ContentMask<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.content_mask,
            Primitive::Quad(quad) => &quad.content_mask,
            Primitive::Path(path) => &path.content_mask,
            Primitive::Underline(underline) => &underline.content_mask,
            Primitive::MonochromeSprite(sprite) => &sprite.content_mask,
            Primitive::SubpixelSprite(sprite) => &sprite.content_mask,
            Primitive::PolychromeSprite(sprite) => &sprite.content_mask,
            Primitive::Surface(surface) => &surface.content_mask,
        }
    }
}

#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
struct BatchIterator<'a> {
    shadows_start: usize,
    shadows_iter: Peekable<slice::Iter<'a, Shadow>>,
    quads_start: usize,
    quads_iter: Peekable<slice::Iter<'a, Quad>>,
    paths_start: usize,
    paths_iter: Peekable<slice::Iter<'a, Path<ScaledPixels>>>,
    underlines_start: usize,
    underlines_iter: Peekable<slice::Iter<'a, Underline>>,
    monochrome_sprites_start: usize,
    monochrome_sprites_iter: Peekable<slice::Iter<'a, MonochromeSprite>>,
    subpixel_sprites_start: usize,
    subpixel_sprites_iter: Peekable<slice::Iter<'a, SubpixelSprite>>,
    polychrome_sprites_start: usize,
    polychrome_sprites_iter: Peekable<slice::Iter<'a, PolychromeSprite>>,
    surfaces_start: usize,
    surfaces_iter: Peekable<slice::Iter<'a, PaintSurface>>,
}

impl<'a> Iterator for BatchIterator<'a> {
    type Item = PrimitiveBatch;

    fn next(&mut self) -> Option<Self::Item> {
        let mut orders_and_kinds = [
            (
                self.shadows_iter.peek().map(|s| s.order),
                PrimitiveKind::Shadow,
            ),
            (self.quads_iter.peek().map(|q| q.order), PrimitiveKind::Quad),
            (self.paths_iter.peek().map(|q| q.order), PrimitiveKind::Path),
            (
                self.underlines_iter.peek().map(|u| u.order),
                PrimitiveKind::Underline,
            ),
            (
                self.monochrome_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::MonochromeSprite,
            ),
            (
                self.subpixel_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::SubpixelSprite,
            ),
            (
                self.polychrome_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::PolychromeSprite,
            ),
            (
                self.surfaces_iter.peek().map(|s| s.order),
                PrimitiveKind::Surface,
            ),
        ];
        orders_and_kinds.sort_by_key(|(order, kind)| (order.unwrap_or(u32::MAX), *kind));

        let first = orders_and_kinds[0];
        let second = orders_and_kinds[1];
        let (batch_kind, max_order_and_kind) = if first.0.is_some() {
            (first.1, (second.0.unwrap_or(u32::MAX), second.1))
        } else {
            return None;
        };

        match batch_kind {
            PrimitiveKind::Shadow => {
                let shadows_start = self.shadows_start;
                let mut shadows_end = shadows_start + 1;
                self.shadows_iter.next();
                while self
                    .shadows_iter
                    .next_if(|shadow| (shadow.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    shadows_end += 1;
                }
                self.shadows_start = shadows_end;
                Some(PrimitiveBatch::Shadows(shadows_start..shadows_end))
            }
            PrimitiveKind::Quad => {
                let quads_start = self.quads_start;
                let mut quads_end = quads_start + 1;
                self.quads_iter.next();
                while self
                    .quads_iter
                    .next_if(|quad| (quad.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    quads_end += 1;
                }
                self.quads_start = quads_end;
                Some(PrimitiveBatch::Quads(quads_start..quads_end))
            }
            PrimitiveKind::Path => {
                let paths_start = self.paths_start;
                let mut paths_end = paths_start + 1;
                self.paths_iter.next();
                while self
                    .paths_iter
                    .next_if(|path| (path.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    paths_end += 1;
                }
                self.paths_start = paths_end;
                Some(PrimitiveBatch::Paths(paths_start..paths_end))
            }
            PrimitiveKind::Underline => {
                let underlines_start = self.underlines_start;
                let mut underlines_end = underlines_start + 1;
                self.underlines_iter.next();
                while self
                    .underlines_iter
                    .next_if(|underline| (underline.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    underlines_end += 1;
                }
                self.underlines_start = underlines_end;
                Some(PrimitiveBatch::Underlines(underlines_start..underlines_end))
            }
            PrimitiveKind::MonochromeSprite => {
                let texture_id = self.monochrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.monochrome_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.monochrome_sprites_iter.next();
                while self
                    .monochrome_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.monochrome_sprites_start = sprites_end;
                Some(PrimitiveBatch::MonochromeSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::SubpixelSprite => {
                let texture_id = self.subpixel_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.subpixel_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.subpixel_sprites_iter.next();
                while self
                    .subpixel_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.subpixel_sprites_start = sprites_end;
                Some(PrimitiveBatch::SubpixelSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::PolychromeSprite => {
                let texture_id = self.polychrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.polychrome_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.polychrome_sprites_iter.next();
                while self
                    .polychrome_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.polychrome_sprites_start = sprites_end;
                Some(PrimitiveBatch::PolychromeSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::Surface => {
                let surfaces_start = self.surfaces_start;
                let mut surfaces_end = surfaces_start + 1;
                self.surfaces_iter.next();
                while self
                    .surfaces_iter
                    .next_if(|surface| (surface.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    surfaces_end += 1;
                }
                self.surfaces_start = surfaces_end;
                Some(PrimitiveBatch::Surfaces(surfaces_start..surfaces_end))
            }
        }
    }
}

#[derive(Debug)]
#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
#[allow(missing_docs)]
pub enum PrimitiveBatch {
    Shadows(Range<usize>),
    Quads(Range<usize>),
    Paths(Range<usize>),
    Underlines(Range<usize>),
    MonochromeSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    SubpixelSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    PolychromeSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    Surfaces(Range<usize>),
}

impl PrimitiveBatch {
    #[expect(missing_docs)]
    pub fn label(&self) -> String {
        match self {
            Self::Shadows(range) => format!("shadows ({})", range.len()),
            Self::Quads(range) => format!("quads ({})", range.len()),
            Self::Paths(range) => format!("paths ({})", range.len()),
            Self::Underlines(range) => format!("underlines ({})", range.len()),
            Self::MonochromeSprites { texture_id, range } => {
                format!(
                    "monochrome sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::SubpixelSprites { texture_id, range } => {
                format!(
                    "subpixel sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::PolychromeSprites { texture_id, range } => {
                format!(
                    "polychrome sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::Surfaces(range) => format!("surfaces ({})", range.len()),
        }
    }
}

#[derive(Default, Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Quad {
    pub order: DrawOrder,
    pub border_style: BorderStyle,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub background: Background,
    pub border_color: Hsla,
    pub corner_radii: Corners<ScaledPixels>,
    pub border_widths: Edges<ScaledPixels>,
}

impl From<Quad> for Primitive {
    fn from(quad: Quad) -> Self {
        Primitive::Quad(quad)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Underline {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub thickness: ScaledPixels,
    pub wavy: PaddedBool32,
}

impl From<Underline> for Primitive {
    fn from(underline: Underline) -> Self {
        Primitive::Underline(underline)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Shadow {
    pub order: DrawOrder,
    pub blur_radius: ScaledPixels,
    pub bounds: Bounds<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub element_bounds: Bounds<ScaledPixels>,
    pub element_corner_radii: Corners<ScaledPixels>,
    /// 0 = drop shadow (rendered outside the element), 1 = inset shadow (rendered inside).
    pub inset: u32,
    pub pad: u32, // align to 8 bytes
}

impl From<Shadow> for Primitive {
    fn from(shadow: Shadow) -> Self {
        Primitive::Shadow(shadow)
    }
}

/// The style of a border.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[repr(C)]
pub enum BorderStyle {
    /// A solid border.
    #[default]
    Solid = 0,
    /// A dashed border.
    Dashed = 1,
}

/// A data type representing a 2 dimensional transformation that can be applied to an element.
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct TransformationMatrix {
    /// 2x2 matrix containing rotation and scale,
    /// stored row-major
    pub rotation_scale: [[f32; 2]; 2],
    /// translation vector
    pub translation: [f32; 2],
}

impl Eq for TransformationMatrix {}

impl TransformationMatrix {
    /// The unit matrix, has no effect.
    pub fn unit() -> Self {
        Self {
            rotation_scale: [[1.0, 0.0], [0.0, 1.0]],
            translation: [0.0, 0.0],
        }
    }

    /// Move the origin by a given point
    pub fn translate(self, point: Point<ScaledPixels>) -> Self {
        self.compose(Self {
            rotation_scale: [[1.0, 0.0], [0.0, 1.0]],
            translation: [point.x.0, point.y.0],
        })
    }

    /// Clockwise rotation in radians around the origin
    pub fn rotate(self, angle: Radians) -> Self {
        self.compose(Self {
            rotation_scale: [
                [angle.0.cos(), -angle.0.sin()],
                [angle.0.sin(), angle.0.cos()],
            ],
            translation: [0.0, 0.0],
        })
    }

    /// Scale around the origin
    pub fn scale(self, size: Size<f32>) -> Self {
        self.compose(Self {
            rotation_scale: [[size.width, 0.0], [0.0, size.height]],
            translation: [0.0, 0.0],
        })
    }

    /// Perform matrix multiplication with another transformation
    /// to produce a new transformation that is the result of
    /// applying both transformations: first, `other`, then `self`.
    #[inline]
    pub fn compose(self, other: TransformationMatrix) -> TransformationMatrix {
        if other == Self::unit() {
            return self;
        }
        // Perform matrix multiplication
        TransformationMatrix {
            rotation_scale: [
                [
                    self.rotation_scale[0][0] * other.rotation_scale[0][0]
                        + self.rotation_scale[0][1] * other.rotation_scale[1][0],
                    self.rotation_scale[0][0] * other.rotation_scale[0][1]
                        + self.rotation_scale[0][1] * other.rotation_scale[1][1],
                ],
                [
                    self.rotation_scale[1][0] * other.rotation_scale[0][0]
                        + self.rotation_scale[1][1] * other.rotation_scale[1][0],
                    self.rotation_scale[1][0] * other.rotation_scale[0][1]
                        + self.rotation_scale[1][1] * other.rotation_scale[1][1],
                ],
            ],
            translation: [
                self.translation[0]
                    + self.rotation_scale[0][0] * other.translation[0]
                    + self.rotation_scale[0][1] * other.translation[1],
                self.translation[1]
                    + self.rotation_scale[1][0] * other.translation[0]
                    + self.rotation_scale[1][1] * other.translation[1],
            ],
        }
    }

    /// Apply transformation to a point, mainly useful for debugging
    pub fn apply(&self, point: Point<Pixels>) -> Point<Pixels> {
        let input = [point.x.0, point.y.0];
        let mut output = self.translation;
        for (i, output_cell) in output.iter_mut().enumerate() {
            for (k, input_cell) in input.iter().enumerate() {
                *output_cell += self.rotation_scale[i][k] * *input_cell;
            }
        }
        Point::new(output[0].into(), output[1].into())
    }
}

impl Default for TransformationMatrix {
    fn default() -> Self {
        Self::unit()
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct MonochromeSprite {
    pub order: DrawOrder,
    pub pad: u32,
    pub tile: AtlasTile,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub transformation: TransformationMatrix,
}

impl From<MonochromeSprite> for Primitive {
    fn from(sprite: MonochromeSprite) -> Self {
        Primitive::MonochromeSprite(sprite)
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct SubpixelSprite {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub tile: AtlasTile,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub transformation: TransformationMatrix,
}

impl From<SubpixelSprite> for Primitive {
    fn from(sprite: SubpixelSprite) -> Self {
        Primitive::SubpixelSprite(sprite)
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PolychromeSprite {
    pub order: DrawOrder,
    pub pad: u32,
    pub tile: AtlasTile,
    pub grayscale: PaddedBool32,
    pub opacity: f32,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
}

impl From<PolychromeSprite> for Primitive {
    fn from(sprite: PolychromeSprite) -> Self {
        Primitive::PolychromeSprite(sprite)
    }
}

#[derive(Clone, Debug)]
#[allow(missing_docs)]
pub struct PaintSurface {
    pub order: DrawOrder,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub image_buffer: objc2_core_foundation::CFRetained<objc2_core_video::CVPixelBuffer>,
}

impl From<PaintSurface> for Primitive {
    fn from(surface: PaintSurface) -> Self {
        Primitive::Surface(surface)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[expect(missing_docs)]
pub struct PathId(pub usize);

/// A line made up of a series of vertices and control points.
#[derive(Clone, Debug)]
#[expect(missing_docs)]
pub struct Path<P: Clone + Debug + Default + PartialEq> {
    pub id: PathId,
    pub order: DrawOrder,
    pub bounds: Bounds<P>,
    pub content_mask: ContentMask<P>,
    pub vertices: Vec<PathVertex<P>>,
    pub color: Background,
    start: Point<P>,
    current: Point<P>,
    contour_count: usize,
}

impl Path<Pixels> {
    /// Create a new path with the given starting point.
    pub fn new(start: Point<Pixels>) -> Self {
        Self {
            id: PathId(0),
            order: DrawOrder::default(),
            vertices: Vec::new(),
            start,
            current: start,
            bounds: Bounds {
                origin: start,
                size: Default::default(),
            },
            content_mask: Default::default(),
            color: Default::default(),
            contour_count: 0,
        }
    }

    /// Scale this path by the given factor.
    pub fn scale(&self, factor: f32) -> Path<ScaledPixels> {
        Path {
            id: self.id,
            order: self.order,
            bounds: self.bounds.scale(factor),
            content_mask: self.content_mask.scale(factor),
            vertices: self
                .vertices
                .iter()
                .map(|vertex| vertex.scale(factor))
                .collect(),
            start: self.start.map(|start| start.scale(factor)),
            current: self.current.scale(factor),
            contour_count: self.contour_count,
            color: self.color,
        }
    }

    /// Move the start, current point to the given point.
    pub fn move_to(&mut self, to: Point<Pixels>) {
        self.contour_count += 1;
        self.start = to;
        self.current = to;
    }

    /// Draw a straight line from the current point to the given point.
    pub fn line_to(&mut self, to: Point<Pixels>) {
        self.contour_count += 1;
        if self.contour_count > 1 {
            self.push_triangle(
                (self.start, self.current, to),
                (point(0., 1.), point(0., 1.), point(0., 1.)),
            );
        }
        self.current = to;
    }

    /// Draw a curve from the current point to the given point, using the given control point.
    pub fn curve_to(&mut self, to: Point<Pixels>, ctrl: Point<Pixels>) {
        self.contour_count += 1;
        if self.contour_count > 1 {
            self.push_triangle(
                (self.start, self.current, to),
                (point(0., 1.), point(0., 1.), point(0., 1.)),
            );
        }

        self.push_triangle(
            (self.current, ctrl, to),
            (point(0., 0.), point(0.5, 0.), point(1., 1.)),
        );
        self.current = to;
    }

    /// Push a triangle to the Path.
    pub fn push_triangle(
        &mut self,
        xy: (Point<Pixels>, Point<Pixels>, Point<Pixels>),
        st: (Point<f32>, Point<f32>, Point<f32>),
    ) {
        self.bounds = self
            .bounds
            .union(&Bounds {
                origin: xy.0,
                size: Default::default(),
            })
            .union(&Bounds {
                origin: xy.1,
                size: Default::default(),
            })
            .union(&Bounds {
                origin: xy.2,
                size: Default::default(),
            });

        self.vertices.push(PathVertex {
            xy_position: xy.0,
            st_position: st.0,
            content_mask: Default::default(),
        });
        self.vertices.push(PathVertex {
            xy_position: xy.1,
            st_position: st.1,
            content_mask: Default::default(),
        });
        self.vertices.push(PathVertex {
            xy_position: xy.2,
            st_position: st.2,
            content_mask: Default::default(),
        });
    }
}

impl<T> Path<T>
where
    T: Clone + Debug + Default + PartialEq + PartialOrd + Add<T, Output = T> + Sub<Output = T>,
{
    #[allow(unused)]
    #[expect(missing_docs)]
    pub fn clipped_bounds(&self) -> Bounds<T> {
        self.bounds.intersect(&self.content_mask.bounds)
    }
}

impl From<Path<ScaledPixels>> for Primitive {
    fn from(path: Path<ScaledPixels>) -> Self {
        Primitive::Path(path)
    }
}

#[derive(Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathVertex<P: Clone + Debug + Default + PartialEq> {
    pub xy_position: Point<P>,
    pub st_position: Point<f32>,
    pub content_mask: ContentMask<P>,
}

#[expect(missing_docs)]
impl PathVertex<Pixels> {
    pub fn scale(&self, factor: f32) -> PathVertex<ScaledPixels> {
        PathVertex {
            xy_position: self.xy_position.scale(factor),
            st_position: self.st_position,
            content_mask: self.content_mask.scale(factor),
        }
    }
}

/// mirin: whether a scene's description (`Window::scene_drawn`) says which
/// subpixel variant each glyph is (`describe_glyph_variants`).
static GLYPH_VARIANTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// mirin: make a scene's description (`Window::scene_drawn`) say which
/// subpixel variant each glyph is drawn as: for checking that a glyph moved
/// with a retained subtree is the one drawing it there gives. A scene
/// described so differs from one described without it. Always on in this
/// crate's tests. Port of `../gpui`'s row.
#[doc(hidden)]
pub fn describe_glyph_variants(on: bool) {
    GLYPH_VARIANTS.store(on, std::sync::atomic::Ordering::Relaxed);
}

fn describes_glyph_variants() -> bool {
    cfg!(test) || GLYPH_VARIANTS.load(std::sync::atomic::Ordering::Relaxed)
}
