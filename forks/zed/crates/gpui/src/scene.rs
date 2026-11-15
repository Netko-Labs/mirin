// todo("windows"): remove
#![cfg_attr(windows, allow(dead_code))]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AtlasTextureId, AtlasTile, Background, Bounds, ContentMask, Corners, Edges, Hsla, Path,
    PathTiles, Pixels, Point, Radians, ScaledPixels, Size, TimedTransformation,
    bounds_tree::BoundsTree, elements::MaskMap, window::MaskId,
};
use smallvec::SmallVec;
use std::{
    cmp::Ordering, collections::VecDeque, fmt::Debug, iter::Peekable, ops::Range, rc::Rc, slice,
    time::Duration,
};

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

impl PaddedBool32 {
    /// The wrapped boolean.
    pub fn as_bool(self) -> bool {
        self.0 != 0
    }
}

struct Layer {
    primitives: SmallVec<[Range<usize>; 1]>,
    bounds: Bounds<ScaledPixels>,
    max_kind: PrimitiveKind,
    max_shared_kind: PrimitiveKind,
}

#[derive(Default)]
#[expect(missing_docs)]
pub struct Scene {
    pub(crate) paint_operations: Vec<PaintOperation>,
    primitive_bounds: BoundsTree<ScaledPixels>,
    layer_stack: Vec<usize>,
    layers: VecDeque<Layer>,
    pub shadows: Vec<Shadow>,
    pub quads: Vec<Quad>,
    pub paths: Vec<PaintedPath>,
    pub underlines: Vec<Underline>,
    pub monochrome_sprites: Vec<MonochromeSprite>,
    pub subpixel_sprites: Vec<SubpixelSprite>,
    pub polychrome_sprites: Vec<PolychromeSprite>,
    pub surfaces: Vec<PaintSurface>,
    animations: Vec<SpriteAnimation>,
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
            // An animation moves its sprite about a center of its own.
            Primitive::MonochromeSprite(sprite) => {
                sprite.transformation != TransformationMatrix::unit()
                    || sprite.animation.is_animation()
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
    /// Whoever copies the drawing takes in how far it reaches itself, from
    /// what was recorded when it was drawn (`Window::absorb_retained`): a
    /// subtree being drawn anew around it need not be told again primitive
    /// by primitive (`SceneReach::take_in`).
    pub(crate) absorbed: bool,
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
            return primitive.clipped_bounds();
        };
        let shown = (*primitive.bounds() + by).intersect(&self.map.cover(mask_id).bounds);
        match strip {
            Some(strip) => shown.intersect(&(strip.bounds + by)),
            None => shown,
        }
    }
}

#[expect(missing_docs)]
impl Scene {
    pub fn clear(&mut self) {
        self.mask_id = 0;
        self.paint_operations.clear();
        self.primitive_bounds.clear();
        self.layer_stack.clear();
        self.layers.clear();
        self.paths.clear();
        self.shadows.clear();
        self.quads.clear();
        self.underlines.clear();
        self.monochrome_sprites.clear();
        self.subpixel_sprites.clear();
        self.polychrome_sprites.clear();
        self.surfaces.clear();
        self.animations.clear();
    }

    /// Inserts a sprite that [`Self::advance_animations`] keeps moving. The
    /// sprite's color is taken as its color before the animation's alpha.
    pub(crate) fn insert_animated_sprite(
        &mut self,
        sprite: MonochromeSprite,
        animation: SpriteAnimation,
    ) {
        self.insert_animated_op(sprite, animation, self.mask_id, false);
    }

    /// mirin: `insert_animated_sprite`, under the mask `mask_id`, and for a
    /// sprite of a copied drawing (`replayed`), as `insert_op`. One kept in
    /// the drawing unshown has no animation: ids count the scene's.
    fn insert_animated_op(
        &mut self,
        mut sprite: MonochromeSprite,
        mut animation: SpriteAnimation,
        mask_id: MaskId,
        replayed: bool,
    ) {
        sprite.animation = SpriteAnimationId(self.animations.len() as u32);
        animation.base_color = sprite.color;
        let index = self.paint_operations.len();
        if self.insert_op(sprite.into(), None, mask_id, replayed) {
            self.animations.push(animation);
        } else if let Some(PaintOperation::Primitive(Primitive::MonochromeSprite(sprite), _)) =
            self.paint_operations.get_mut(index)
        {
            sprite.animation = SpriteAnimationId::NONE;
        }
    }

    /// How long the window may wait between presents of this scene while only
    /// its animations need a frame: `None` when nothing in it animates, and
    /// zero when an animation wants every frame.
    pub(crate) fn animation_frame_interval(&self) -> Option<Duration> {
        self.animations
            .iter()
            .map(|animation| {
                animation
                    .transformation
                    .min_frame_interval()
                    .unwrap_or_default()
            })
            .min()
    }

    /// Moves every animated sprite to its pose at `elapsed` time on the app's
    /// synced animation clock, without the scene being rebuilt.
    pub(crate) fn advance_animations(&mut self, elapsed: Duration) {
        for animation in &self.animations {
            let Some(sprite) = self.monochrome_sprites.get_mut(animation.sprite_index) else {
                continue;
            };
            let pose = animation.transformation.at(elapsed);
            sprite.transformation = pose.into_matrix(animation.center, animation.scale_factor);
            sprite.color = animation.base_color.opacity(pose.alpha_factor());
        }
    }

    pub fn len(&self) -> usize {
        self.paint_operations.len()
    }

    pub fn push_layer(&mut self) {
        self.layer_stack.push(self.layers.len());
        self.layers.push_back(Layer {
            primitives: SmallVec::new(),
            bounds: Bounds::default(),
            max_kind: PrimitiveKind::Shadow,
            max_shared_kind: PrimitiveKind::Surface,
        });
        self.paint_operations.push(PaintOperation::StartLayer);
    }

    pub fn pop_layer(&mut self) {
        self.layer_stack.pop();
        if self.layer_stack.is_empty() {
            while let Some(layer) = self.layers.pop_front() {
                self.insert_layer(layer);
            }
        }
        self.paint_operations.push(PaintOperation::EndLayer);
    }

    fn insert_layer(&mut self, layer: Layer) {
        if layer.primitives.is_empty() {
            return;
        }
        let order =
            self.primitive_bounds
                .insert(layer.bounds, layer.max_kind, layer.max_shared_kind);
        for index in layer.primitives.into_iter().flatten() {
            // mirin: a quad's strip too, and the operation keeps the order.
            if let Some(primitive) = self.paint_operations[index].primitive_mut() {
                primitive.set_order(order);
                let primitive = primitive.clone();
                self.push_primitive(primitive, order);
            }
        }
    }

    pub fn insert_primitive(&mut self, primitive: impl Into<Primitive>) {
        self.insert_op(primitive.into(), None, self.mask_id, false);
    }

    /// mirin: one strip of a quad drawn in strips (`Window::insert_quad`: a
    /// border's four, and the interior they surround): `quad` under the mask
    /// it is drawn under, clipped to `strip`. The strip and that mask are
    /// kept with it, so a retained subtree's drawing copied elsewhere clips
    /// it there as drawing it there would (`Placing::place`), and while one
    /// is drawn anew a strip that mask hides is kept near it (unshown) as
    /// any primitive is.
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

    /// mirin: upstream's `try_insert_primitive` (whether the primitive
    /// shows, rather than being clipped away), for a quad's strip too
    /// (`strip`), under the mask `mask_id`, and for a primitive of a copied
    /// drawing (`replayed`): one hidden stays in it (unshown), so the copy
    /// is as whole as the drawing it copies. The operation keeps the draw
    /// order its primitive got (a layer's when the layer closes,
    /// `insert_layer`), for `replay_as_one`.
    fn insert_op(
        &mut self,
        mut primitive: Primitive,
        strip: Option<Strip>,
        mask_id: MaskId,
        replayed: bool,
    ) -> bool {
        let clipped_bounds = primitive.clipped_bounds();

        // mirin: counted whether it shows or not; hidden near the mask
        // around a retained subtree drawn anew, kept unshown (`SceneReach`).
        if let Some(reach) = &mut self.reach {
            reach.take_in(&primitive, strip.as_ref(), !replayed);
            if clipped_bounds.is_empty() {
                if replayed || reach.keeps(&primitive, strip.as_ref()) {
                    self.paint_operations
                        .push(PaintOperation::of(primitive, strip, mask_id));
                }
                return false;
            }
        }

        if clipped_bounds.is_empty() {
            if replayed {
                self.paint_operations
                    .push(PaintOperation::of(primitive, strip, mask_id));
            }
            return false;
        }

        let kind = primitive.kind();
        if let Some(&layer) = self.layer_stack.last()
            && let Some(layer) = self.layers.get_mut(layer)
        {
            layer.bounds = layer.bounds.join(&clipped_bounds);
            layer.max_kind = layer.max_kind.max(kind);
            layer.max_shared_kind = layer.max_shared_kind.min(kind.max_shared_kind());
            let index = self.paint_operations.len();
            match layer.primitives.last_mut() {
                Some(range) if range.end == index => range.end += 1,
                _ => layer.primitives.push(index..index + 1),
            }
        } else {
            let order = self
                .primitive_bounds
                .insert(clipped_bounds, kind, kind.max_shared_kind());
            primitive.set_order(order);
            self.push_primitive(primitive.clone(), order);
        }
        self.paint_operations
            .push(PaintOperation::of(primitive, strip, mask_id));
        true
    }

    fn push_primitive(&mut self, primitive: Primitive, order: DrawOrder) {
        match primitive {
            Primitive::Shadow(shadow) => self.shadows.push(Shadow { order, ..shadow }),
            Primitive::Quad(quad) => self.quads.push(Quad { order, ..quad }),
            Primitive::Path(mut path) => {
                path.order = order;
                self.paths.push(path);
            }
            Primitive::Underline(underline) => {
                self.underlines.push(Underline { order, ..underline })
            }
            Primitive::MonochromeSprite(sprite) => self
                .monochrome_sprites
                .push(MonochromeSprite { order, ..sprite }),
            Primitive::SubpixelSprite(sprite) => self
                .subpixel_sprites
                .push(SubpixelSprite { order, ..sprite }),
            Primitive::PolychromeSprite(sprite) => self
                .polychrome_sprites
                .push(PolychromeSprite { order, ..sprite }),
            Primitive::Surface(mut surface) => {
                surface.order = order;
                self.surfaces.push(surface);
            }
        }
    }

    /// mirin: upstream's `replay`, for a drawing copied where it was or
    /// `placing.by` device pixels (whole ones) away (a retained subtree's,
    /// `elements::retained`): each primitive, strip, layer and the masks
    /// they were drawn under are copied (`MaskMap`), and when it moved each
    /// is moved and clipped by its mask as that clips here. A layer is as
    /// wide as what shows in it (upstream's `insert_layer`), so one that
    /// ends up empty takes no draw order, as drawing it here would not.
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
        if as_one && self.replay_as_one(operations, prev_scene, placing) {
            return;
        }
        for operation in operations {
            match operation {
                PaintOperation::Primitive(..) | PaintOperation::Strip(..) => {
                    let (primitive, strip, mask_id) = operation.placed(placing);
                    // Animation ids index the scene they were inserted into.
                    if let Primitive::MonochromeSprite(sprite) = &primitive
                        && let Some(animation) = prev_scene.animation(sprite)
                    {
                        self.insert_animated_op(*sprite, *animation, mask_id, true);
                    } else {
                        self.insert_op(primitive, strip, mask_id, true);
                    }
                }
                PaintOperation::StartLayer => self.push_layer(),
                PaintOperation::EndLayer => self.pop_layer(),
            }
        }
    }

    /// mirin: the animation of a sprite of this scene, if it has one.
    fn animation(&self, sprite: &MonochromeSprite) -> Option<&SpriteAnimation> {
        self.animations.get(sprite.animation.0 as usize)
    }

    /// mirin: replay a drawing as one, when each of its primitives shows
    /// where it is copied exactly when it showed where it was and nothing
    /// around it is a layer: its bounds go into the bounds tree once
    /// (`BoundsTree::insert_spanning`), as wide as what it shows, and its
    /// primitives keep their draw orders among themselves, rebased above
    /// whatever was drawn under those bounds; what is drawn over them later
    /// comes after them all. Upstream's `replay` put each primitive in the
    /// tree again to find its order: a third of a frame that copies most of
    /// the window. What overlaps is painted in the same order either way
    /// (only the numbers differ: `stacking` in the tests). Whether it was.
    ///
    /// Upstream lets a primitive share the draw order of one it overlaps
    /// when its kind is drawn after that one's, and primitives of one kind
    /// and order are drawn as they come in their list. So the drawing's
    /// first primitives share the order under them where each of them could
    /// (`share`), a later primitive may share its last order where it could
    /// share with each of the last (`top`), and its primitives go into their
    /// lists in the sequence they went in when it was drawn: those in a
    /// layer when the outermost layer around them closes, layer by layer
    /// (`insert_layer`).
    fn replay_as_one(
        &mut self,
        operations: &[PaintOperation],
        prev_scene: &Scene,
        placing: Placing<'_>,
    ) -> bool {
        if !self.layer_stack.is_empty() {
            return false;
        }
        // Where it shows, the span of its draw orders, the least kind its
        // first primitives can share an order with and the highest kind
        // among its last.
        struct Unit {
            bounds: Bounds<ScaledPixels>,
            first: DrawOrder,
            last: DrawOrder,
            share: PrimitiveKind,
            top: PrimitiveKind,
        }
        let mut unit: Option<Unit> = None;
        // mirin: where it was, each shows as it did.
        let moved = placing.by.is_some();
        for operation in operations {
            let (primitive, mask_id) = match operation {
                PaintOperation::Primitive(primitive, mask_id)
                | PaintOperation::Strip(primitive, _, mask_id) => (primitive, *mask_id),
                PaintOperation::StartLayer | PaintOperation::EndLayer => continue,
            };
            // An animation is the scene's, not the sprite's: the long way.
            if let Primitive::MonochromeSprite(sprite) = primitive
                && prev_scene.animation(sprite).is_some()
            {
                return false;
            }
            let was = primitive.clipped_bounds();
            let now = if moved {
                placing.shown(primitive, operation.strip(), mask_id)
            } else {
                was
            };
            if was.is_empty() != now.is_empty() {
                return false;
            }
            if now.is_empty() {
                continue;
            }
            let (order, kind) = (primitive.order(), primitive.kind());
            let share = kind.max_shared_kind();
            unit = Some(match unit {
                Some(unit) => Unit {
                    bounds: unit.bounds.union(&now),
                    first: unit.first.min(order),
                    last: unit.last.max(order),
                    share: match order.cmp(&unit.first) {
                        Ordering::Less => share,
                        Ordering::Equal => unit.share.min(share),
                        Ordering::Greater => unit.share,
                    },
                    top: match order.cmp(&unit.last) {
                        Ordering::Greater => kind,
                        Ordering::Equal => unit.top.max(kind),
                        Ordering::Less => unit.top,
                    },
                },
                None => Unit {
                    bounds: now,
                    first: order,
                    last: order,
                    share,
                    top: kind,
                },
            });
        }
        let rebase = unit.map(|unit| {
            let base = self.primitive_bounds.insert_spanning(
                unit.bounds,
                unit.last - unit.first,
                unit.top,
                unit.share,
            );
            (base, unit.first)
        });
        // mirin: each operation is copied straight into this frame's list
        // and placed there, and what shows is copied from there into its
        // primitive list: two copies of a primitive where taking it out,
        // placing it and handing it on made four or five (a copied frame's
        // largest single cost on the stress app).
        self.paint_operations.reserve(operations.len());
        // The layers open in the drawing, each by the number it was opened
        // as, and what shows in them, to go into its list when the outermost
        // closes: the number of its layer, and its operation here.
        let mut open: SmallVec<[u32; 4]> = SmallVec::new();
        let mut opened = 0;
        let mut in_layers: Vec<(u32, usize)> = Vec::new();
        for operation in operations {
            match operation {
                PaintOperation::Primitive(..) | PaintOperation::Strip(..) => {
                    let index = self.paint_operations.len();
                    self.paint_operations.push(operation.clone());
                    let Some(placed) = self.paint_operations.last_mut() else {
                        continue;
                    };
                    placed.place(placing);
                    let (primitive, strip) = match placed {
                        PaintOperation::Primitive(primitive, _) => (primitive, None),
                        PaintOperation::Strip(primitive, strip, _) => (primitive, Some(&*strip)),
                        _ => continue,
                    };
                    if let Some(reach) = self.reach.as_mut().filter(|_| !placing.absorbed) {
                        reach.take_in(primitive, strip, false);
                    }
                    let shows = !primitive.clipped_bounds().is_empty();
                    // Hidden as it was: kept, unshown.
                    let Some((base, first)) = rebase.filter(|_| shows) else {
                        continue;
                    };
                    let order = base + (primitive.order() - first);
                    primitive.set_order(order);
                    match open.last() {
                        Some(layer) => in_layers.push((*layer, index)),
                        None => {
                            let primitive = primitive.clone();
                            self.push_primitive(primitive, order);
                        }
                    }
                }
                PaintOperation::StartLayer => {
                    // Its primitives carry its order already.
                    open.push(opened);
                    opened += 1;
                    self.paint_operations.push(PaintOperation::StartLayer);
                }
                PaintOperation::EndLayer => {
                    open.pop();
                    self.paint_operations.push(PaintOperation::EndLayer);
                    if open.is_empty() && !in_layers.is_empty() {
                        // Stable: a layer's primitives stay in sequence.
                        in_layers.sort_by_key(|(layer, _)| *layer);
                        for (_, index) in in_layers.drain(..) {
                            if let Some(primitive) = self.paint_operations[index].primitive() {
                                let primitive = primitive.clone();
                                self.push_primitive(primitive.clone(), primitive.order());
                            }
                        }
                    }
                }
            }
        }
        true
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
        let shown = |primitive: &Primitive| primitive.clipped_bounds();
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
        debug_assert!(self.layer_stack.is_empty(), "unbalanced scene layers");
        let keys = &mut Vec::new();
        sort_in_place(&mut self.shadows, keys, |shadow| (shadow.order, 0));
        sort_in_place(&mut self.quads, keys, |quad| (quad.order, 0));
        self.paths.sort_by_key(|path| path.order);
        sort_in_place(&mut self.underlines, keys, |underline| (underline.order, 0));
        sort_in_place(&mut self.monochrome_sprites, keys, |sprite| {
            (sprite.order, sprite.tile.texture_id.index)
        });
        sort_in_place(&mut self.subpixel_sprites, keys, |sprite| {
            (sprite.order, sprite.tile.texture_id.index)
        });
        sort_in_place(&mut self.polychrome_sprites, keys, |sprite| {
            (sprite.order, sprite.tile.texture_id.index)
        });
        self.surfaces.sort_by_key(|surface| surface.order);

        // Sorting moved the sprites, so animations learn where theirs ended up.
        if !self.animations.is_empty() {
            for (index, sprite) in self.monochrome_sprites.iter().enumerate() {
                if let Some(animation) = self.animations.get_mut(sprite.animation.0 as usize) {
                    animation.sprite_index = index;
                }
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

/// Sorts small `(key, index)` pairs instead of the primitives themselves, then moves each
/// primitive into place once. Primitives are large, so a comparison sort that shuffles them
/// directly spends most of its time copying. Ties keep insertion order, as `sort_by_key`
/// does, because the index is part of what is sorted.
fn sort_in_place<T: Copy>(
    primitives: &mut [T],
    keys: &mut Vec<(u64, u32)>,
    key: impl Fn(&T) -> (u32, u32),
) {
    if primitives.is_sorted_by_key(&key) {
        return;
    }
    keys.clear();
    keys.extend(primitives.iter().enumerate().map(|(index, primitive)| {
        let (major, minor) = key(primitive);
        ((major as u64) << 32 | minor as u64, index as u32)
    }));
    keys.sort_unstable();

    // `keys[target].1` is the source index for `target`. Follow each cycle of that
    // permutation, marking visited slots by pointing them at themselves.
    for start in 0..primitives.len() {
        if keys[start].1 as usize == start {
            continue;
        }
        let displaced = primitives[start];
        let mut target = start;
        loop {
            let source = keys[target].1 as usize;
            keys[target].1 = target as u32;
            if source == start {
                primitives[target] = displaced;
                break;
            }
            primitives[target] = primitives[source];
            target = source;
        }
    }
}

/// The depth step between consecutive quads in a frame with `quad_count` quads.
pub fn quad_depth_scale(quad_count: usize) -> f32 {
    let denominator = (quad_count.min((1 << 24) - 1) + 1).next_power_of_two();
    1.0 / denominator as f32
}

/// Maps a quad's index in [`Scene::quads`] to depth, with greater values closer.
pub fn quad_depth(quad_id: u32, scale: f32) -> f32 {
    ((quad_id + 1) as f32 * scale).min(1.0)
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
            .filter(|primitive| !primitive.clipped_bounds().is_empty())
            .map(Primitive::describe)
            .collect()
    }
}

impl PrimitiveKind {
    /// We guarantee that overlapping primitives are drawn in paint order.
    /// But, to improve GPU draw batching, the renderer sorts primitives that
    /// share a draw order by kind, then by atlas texture, and only then in
    /// paint order. So, a primitive can only share the draw order of the
    /// topmost primitive it overlaps if that primitive's kind is at most the
    /// one returned here. Otherwise, it needs a new draw order.
    fn max_shared_kind(self) -> Self {
        match self {
            Self::MonochromeSprite => Self::Underline,
            Self::SubpixelSprite => Self::MonochromeSprite,
            Self::PolychromeSprite => Self::SubpixelSprite,
            kind => kind,
        }
    }
}

// mirin: `Clone`, for a retained subtree's drawing parked out of a frame.
#[derive(Clone)]
pub(crate) enum PaintOperation {
    // mirin: with the mask it was drawn under, as given (`MaskNode`).
    Primitive(Primitive, MaskId),
    // mirin: a quad's strip, with the strip and the mask it was drawn
    // under (`Scene::insert_strip`).
    Strip(Primitive, Strip, MaskId),
    StartLayer,
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

    /// mirin: the primitive it draws, if any, to give its draw order.
    fn primitive_mut(&mut self) -> Option<&mut Primitive> {
        match self {
            Self::Primitive(primitive, _) | Self::Strip(primitive, ..) => Some(primitive),
            _ => None,
        }
    }

    /// mirin: the strip of a quad it draws, if it does.
    fn strip(&self) -> Option<&Strip> {
        match self {
            Self::Strip(_, strip, _) => Some(strip),
            _ => None,
        }
    }

    /// mirin: the mask it was drawn under (`MaskNode`), to renumber.
    pub(crate) fn mask_id_mut(&mut self) -> Option<&mut MaskId> {
        match self {
            Self::Primitive(_, mask_id) | Self::Strip(_, _, mask_id) => Some(mask_id),
            Self::StartLayer | Self::EndLayer => None,
        }
    }

    /// mirin: place it as `placing` says, where it is (`replay_as_one`):
    /// its primitive (and strip) moved and clipped, under the mask it is
    /// under in this frame. A layer is left as it is.
    fn place(&mut self, placing: Placing<'_>) {
        match self {
            Self::Primitive(primitive, mask_id) => {
                *mask_id = placing.place(primitive, None, *mask_id).1;
            }
            Self::Strip(primitive, strip, mask_id) => {
                let (placed, id) = placing.place(primitive, Some(*strip), *mask_id);
                if let Some(placed) = placed {
                    *strip = placed;
                }
                *mask_id = id;
            }
            Self::StartLayer | Self::EndLayer => {}
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
    Path(PaintedPath),
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
                format!("{path:?}")
            }
            Primitive::Underline(mut underline) => {
                underline.order = 0;
                format!("{underline:?}")
            }
            Primitive::MonochromeSprite(mut sprite_) => {
                sprite_.order = 0;
                sprite_.tile = sprite(&sprite_.tile);
                // mirin: which subpixel variant of the glyph it is
                // (`SpriteAnimationId::glyph_variant`, see
                // `Window::paint_line_glyph`), only when asked: a scene
                // described so is told from one described without it. An
                // animation's id counts the scene's, as a draw order does.
                if !describes_glyph_variants() || sprite_.animation.is_animation() {
                    sprite_.animation = SpriteAnimationId::NONE;
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

    /// mirin: the draw order it got, kept in its operation (`insert_op`).
    fn set_order(&mut self, order: DrawOrder) {
        match self {
            Primitive::Shadow(shadow) => shadow.order = order,
            Primitive::Quad(quad) => quad.order = order,
            Primitive::Path(path) => path.order = order,
            Primitive::Underline(underline) => underline.order = order,
            Primitive::MonochromeSprite(sprite) => sprite.order = order,
            Primitive::SubpixelSprite(sprite) => sprite.order = order,
            Primitive::PolychromeSprite(sprite) => sprite.order = order,
            Primitive::Surface(surface) => surface.order = order,
        }
    }

    pub(crate) fn kind(&self) -> PrimitiveKind {
        match self {
            Primitive::Shadow(_) => PrimitiveKind::Shadow,
            Primitive::Quad(_) => PrimitiveKind::Quad,
            Primitive::Path(_) => PrimitiveKind::Path,
            Primitive::Underline(_) => PrimitiveKind::Underline,
            Primitive::MonochromeSprite(_) => PrimitiveKind::MonochromeSprite,
            Primitive::SubpixelSprite(_) => PrimitiveKind::SubpixelSprite,
            Primitive::PolychromeSprite(_) => PrimitiveKind::PolychromeSprite,
            Primitive::Surface(_) => PrimitiveKind::Surface,
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
    /// (`Scene::replay_placed`). Never a path (its tiles stay where they
    /// were binned), a surface or an animated sprite (`SceneReach`).
    pub(crate) fn move_by(&mut self, by: Point<ScaledPixels>, mask: ContentMask<ScaledPixels>) {
        match self {
            Primitive::Shadow(shadow) => {
                shadow.bounds.origin += by;
                shadow.shape_bounds.origin += by;
                shadow.content_mask = mask;
            }
            Primitive::Quad(quad) => {
                quad.bounds.origin += by;
                quad.content_mask = mask;
            }
            Primitive::Path(path) => {
                path.bounds.origin += by;
                path.paint.content_mask = mask;
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

    fn transformation(&self) -> TransformationMatrix {
        match self {
            Primitive::MonochromeSprite(sprite) => sprite.transformation,
            Primitive::SubpixelSprite(sprite) => sprite.transformation,
            _ => TransformationMatrix::unit(),
        }
    }

    fn clipped_bounds(&self) -> Bounds<ScaledPixels> {
        self.transformation()
            .transform_bounds(*self.bounds())
            .intersect(&self.content_mask().bounds)
    }

    pub fn content_mask(&self) -> &ContentMask<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.content_mask,
            Primitive::Quad(quad) => &quad.content_mask,
            Primitive::Path(path) => &path.paint.content_mask,
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
    paths_iter: Peekable<slice::Iter<'a, PaintedPath>>,
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
            (
                self.paths_iter.peek().map(|path| path.order),
                PrimitiveKind::Path,
            ),
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
    pub shape_bounds: Bounds<ScaledPixels>,
    pub shape_corner_radii: Corners<ScaledPixels>,
    pub inset: PaddedBool32,
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

    /// The smallest bounds that contain `bounds` once it is transformed.
    pub(crate) fn transform_bounds(&self, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
        if *self == Self::unit() {
            return bounds;
        }
        let [[xx, xy], [yx, yy]] = self.rotation_scale;
        let [translate_x, translate_y] = self.translation;
        let corners = [
            bounds.origin,
            bounds.top_right(),
            bounds.bottom_left(),
            bounds.bottom_right(),
        ]
        .map(|corner| {
            Point::new(
                ScaledPixels(xx * corner.x.0 + xy * corner.y.0 + translate_x),
                ScaledPixels(yx * corner.x.0 + yy * corner.y.0 + translate_y),
            )
        });
        let [first, rest @ ..] = corners;
        let top_left = rest.iter().fold(first, |min, corner| min.min(corner));
        let bottom_right = rest.iter().fold(first, |max, corner| max.max(corner));
        Bounds::from_corners(top_left, bottom_right)
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
    pub animation: SpriteAnimationId,
    pub tile: AtlasTile,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub transformation: TransformationMatrix,
}

/// Refers to an animation of the scene a sprite is inserted into.
///
/// A single `u32` so it fits the sprite's existing padding and leaves the
/// instance layout unchanged on every backend; renderers ignore it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(transparent)]
pub struct SpriteAnimationId(u32);

impl SpriteAnimationId {
    /// No animation.
    pub const NONE: Self = Self(u32::MAX);

    /// mirin: no animation either (a scene's are counted from zero, so
    /// none is found at it), for a glyph: which subpixel variant across it
    /// is drawn as, for a scene's description (`describe_glyph_variants`).
    /// A subpixel sprite keeps it in its `pad`; upstream gave a monochrome
    /// sprite's to this id.
    pub(crate) fn glyph_variant(variant: u8) -> Self {
        Self(Self::NONE.0 - 1 - u32::from(variant))
    }

    /// mirin: whether it may name an animation of its scene.
    fn is_animation(self) -> bool {
        self.0 < Self::NONE.0 - 1 - u32::from(u8::MAX)
    }
}

impl Default for SpriteAnimationId {
    fn default() -> Self {
        Self::NONE
    }
}

/// A [`TimedTransformation`] the window applies to a sprite right before
/// every present, so the scene can be presented again without being redrawn.
#[derive(Copy, Clone, Debug)]
pub(crate) struct SpriteAnimation {
    transformation: TimedTransformation,
    center: Point<Pixels>,
    scale_factor: f32,
    base_color: Hsla,
    sprite_index: usize,
}

impl SpriteAnimation {
    pub(crate) fn new(
        transformation: TimedTransformation,
        center: Point<Pixels>,
        scale_factor: f32,
    ) -> Self {
        Self {
            transformation,
            center,
            scale_factor,
            base_color: Hsla::default(),
            sprite_index: usize::MAX,
        }
    }
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

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathCurve {
    pub p0: Point<f32>,
    pub p1: Point<f32>,
    pub a: Point<f32>,
    pub b: Point<f32>,
    pub sign: f32,
    pub pad: u32, // align to 8 bytes
}

#[derive(Clone, Copy, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathPaint {
    /// The path's bounds, in device pixels.
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Background,
    pub even_odd: PaddedBool32,
    pub pad: u32, // align to 8 bytes
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathTile {
    pub paint: u32,
    pub curve_start: u32,
    pub curve_count: u32,
    pub backdrop: i32,
    pub top_left: Point<f32>,
    pub bottom_right: Point<f32>,
    pub reference: Point<f32>,
    pub curves_top_left: Point<f32>,
    pub curves_bottom_right: Point<f32>,
}

#[derive(Clone, Debug)]
#[expect(missing_docs)]
pub struct PaintedPath {
    order: DrawOrder,
    bounds: Bounds<ScaledPixels>,
    tiles: Rc<PathTiles>,
    paint: PathPaint,
}

#[expect(missing_docs)]
impl PaintedPath {
    /// Bins `path` into tiles, to be filled with `color` within `content_mask`.
    pub fn new(
        path: Path,
        scale_factor: f32,
        content_mask: ContentMask<Pixels>,
        color: Background,
    ) -> Self {
        let content_mask = content_mask.scale(scale_factor);
        let mut tiles = path.bin(scale_factor);
        tiles.retain_visible(content_mask.bounds);
        let paint = PathPaint {
            bounds: tiles.bounds(),
            content_mask,
            color,
            even_odd: path.even_odd().into(),
            pad: 0,
        };
        Self {
            order: 0,
            bounds: tiles.painted_bounds(),
            tiles: Rc::new(tiles),
            paint,
        }
    }

    pub fn tile_count(&self) -> usize {
        self.tiles.tiles().len()
    }

    pub fn append_to(
        &self,
        paints: &mut Vec<PathPaint>,
        curves: &mut Vec<PathCurve>,
        tiles: &mut Vec<PathTile>,
    ) {
        let paint_index = paints.len() as u32;
        let curve_start = curves.len() as u32;
        paints.push(self.paint);
        curves.extend_from_slice(self.tiles.curves());
        tiles.extend(self.tiles.tiles().iter().map(|tile| PathTile {
            paint: paint_index,
            curve_start: curve_start + tile.curve_start,
            ..*tile
        }));
    }
}

impl From<PaintedPath> for Primitive {
    fn from(path: PaintedPath) -> Self {
        Primitive::Path(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{point, size};

    fn square(x: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(0.)),
            size: size(ScaledPixels(10.), ScaledPixels(10.)),
        }
    }

    fn quad(x: f32) -> Quad {
        Quad {
            bounds: square(x),
            content_mask: ContentMask { bounds: square(x) },
            ..Default::default()
        }
    }

    fn underline(x: f32) -> Underline {
        Underline {
            order: 0,
            pad: 0,
            bounds: square(x),
            content_mask: ContentMask { bounds: square(x) },
            color: Hsla::default(),
            thickness: ScaledPixels(1.),
            wavy: false.into(),
        }
    }

    fn batch_labels(scene: &mut Scene) -> Vec<String> {
        scene.finish();
        scene.batches().map(|batch| batch.label()).collect()
    }

    #[test]
    fn layers_are_drawn_in_paint_order() {
        // A quad painted after a layer goes above it.
        let mut scene = Scene::default();
        scene.insert_primitive(quad(0.));
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.insert_primitive(underline(5.));
        scene.pop_layer();
        scene.insert_primitive(quad(5.));
        assert_eq!(
            batch_labels(&mut scene),
            ["quads (1)", "underlines (2)", "quads (1)"]
        );

        // A layer goes above the layer painted before it.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.pop_layer();
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
    }

    #[test]
    fn nested_layers_are_drawn_above_their_parents() {
        // A layer has one draw order, so what it paints after a nested layer
        // still goes below that layer.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        scene.insert_primitive(underline(5.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["underlines (2)", "quads (1)"]);

        // The same holds when the nested layer shares its parent's order.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.insert_primitive(quad(0.));
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        scene.insert_primitive(quad(8.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["quads (3)"]);
        assert_eq!(
            scene
                .quads
                .iter()
                .map(|quad| quad.bounds)
                .collect::<Vec<_>>(),
            [square(0.), square(8.), square(5.)]
        );

        // A layer goes above the layers nested in the layer before it.
        let mut scene = Scene::default();
        scene.push_layer();
        scene.push_layer();
        scene.insert_primitive(underline(0.));
        scene.pop_layer();
        scene.pop_layer();
        scene.push_layer();
        scene.insert_primitive(quad(5.));
        scene.pop_layer();
        assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
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
