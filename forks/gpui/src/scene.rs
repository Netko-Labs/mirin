// todo("windows"): remove
#![cfg_attr(windows, allow(dead_code))]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AtlasTextureId, AtlasTile, Background, Bounds, ContentMask, Corners, Edges, Hsla, Pixels,
    Point, Radians, ScaledPixels, Size, bounds_tree::BoundsTree, point,
};
use std::{
    fmt::Debug,
    iter::Peekable,
    ops::{Add, Range, Sub},
    slice,
};

#[allow(non_camel_case_types, unused)]
pub(crate) type PathVertex_ScaledPixels = PathVertex<ScaledPixels>;

pub(crate) type DrawOrder = u32;

#[derive(Default)]
pub(crate) struct Scene {
    pub(crate) paint_operations: Vec<PaintOperation>,
    // mirin: for retained subtrees drawn again elsewhere (`elements::retained`).
    /// Per paint operation, the content mask it was painted under (its
    /// place in the frame's `content_masks`, from 1; 0: none).
    pub(crate) operation_masks: Vec<u32>,
    /// The content mask painted under now (as in `operation_masks`).
    pub(crate) mask_id: u32,
    /// While a retained subtree is drawn anew: a primitive its content mask
    /// hides is kept as a paint operation where this region would show it,
    /// so the subtree's drawing is whole when it is moved into view.
    pub(crate) keep: Option<Bounds<ScaledPixels>>,
    primitive_bounds: BoundsTree<ScaledPixels>,
    layer_stack: Vec<DrawOrder>,
    // mirin: what became of each layer begun and not yet ended.
    layers: Vec<Inserted>,
    pub(crate) shadows: Vec<Shadow>,
    pub(crate) quads: Vec<Quad>,
    pub(crate) paths: Vec<Path<ScaledPixels>>,
    pub(crate) underlines: Vec<Underline>,
    pub(crate) monochrome_sprites: Vec<MonochromeSprite>,
    pub(crate) polychrome_sprites: Vec<PolychromeSprite>,
    pub(crate) surfaces: Vec<PaintSurface>,
}

impl Scene {
    pub fn clear(&mut self) {
        self.paint_operations.clear();
        self.operation_masks.clear();
        self.mask_id = 0;
        self.keep = None;
        self.primitive_bounds.clear();
        self.layer_stack.clear();
        self.layers.clear();
        self.paths.clear();
        self.shadows.clear();
        self.quads.clear();
        self.underlines.clear();
        self.monochrome_sprites.clear();
        self.polychrome_sprites.clear();
        self.surfaces.clear();
    }

    pub fn len(&self) -> usize {
        self.paint_operations.len()
    }

    // mirin: a layer keeps its bounds as they were given and its content
    // mask (not only what the mask leaves of it), so a retained subtree's
    // drawing replayed elsewhere clips it again; `clipped` is what the mask
    // leaves. One the mask hides is kept, hidden, where `keep` would show
    // it. Returns what became of it.
    pub fn push_layer(
        &mut self,
        bounds: Bounds<ScaledPixels>,
        content_mask: ContentMask<ScaledPixels>,
        clipped: Bounds<ScaledPixels>,
    ) -> Inserted {
        let keep = self.keep.is_some_and(|keep| bounds.intersects(&keep));
        self.start_layer(bounds, content_mask, clipped, keep)
    }

    fn start_layer(
        &mut self,
        bounds: Bounds<ScaledPixels>,
        content_mask: ContentMask<ScaledPixels>,
        clipped: Bounds<ScaledPixels>,
        keep_hidden: bool,
    ) -> Inserted {
        let inserted = if !clipped.is_empty() {
            let order = self.primitive_bounds.insert(clipped);
            self.layer_stack.push(order);
            Inserted::Drawn
        } else if keep_hidden {
            Inserted::Hidden
        } else {
            Inserted::Dropped
        };
        self.layers.push(inserted);
        if inserted != Inserted::Dropped {
            self.paint_operations.push(PaintOperation::StartLayer {
                bounds,
                content_mask,
            });
            self.operation_masks.push(self.mask_id);
        }
        inserted
    }

    pub fn pop_layer(&mut self) {
        let inserted = self.layers.pop().unwrap_or(Inserted::Dropped);
        if inserted == Inserted::Drawn {
            self.layer_stack.pop();
        }
        if inserted != Inserted::Dropped {
            self.paint_operations.push(PaintOperation::EndLayer);
            self.operation_masks.push(self.mask_id);
        }
    }

    // mirin: returns what became of the primitive (`Inserted`).
    pub fn insert_primitive(&mut self, primitive: impl Into<Primitive>) -> Inserted {
        let primitive = primitive.into();
        let keep = self
            .keep
            .is_some_and(|keep| primitive.bounds().intersects(&keep));
        self.insert(primitive, keep)
    }

    // mirin: `keep_hidden`: a primitive its content mask hides stays a paint
    // operation (not drawn), for a retained subtree's drawing to be whole.
    fn insert(&mut self, mut primitive: Primitive, keep_hidden: bool) -> Inserted {
        let clipped_bounds = primitive
            .bounds()
            .intersect(&primitive.content_mask().bounds);

        if clipped_bounds.is_empty() {
            if keep_hidden {
                // No order: it is not drawn.
                primitive.set_order(0);
                self.paint_operations
                    .push(PaintOperation::Primitive(primitive));
                self.operation_masks.push(self.mask_id);
                return Inserted::Hidden;
            }
            return Inserted::Dropped;
        }

        let order = self
            .layer_stack
            .last()
            .copied()
            .unwrap_or_else(|| self.primitive_bounds.insert(clipped_bounds));
        match &mut primitive {
            Primitive::Shadow(shadow) => {
                shadow.order = order;
                self.shadows.push(shadow.clone());
            }
            Primitive::Quad(quad) => {
                quad.order = order;
                self.quads.push(quad.clone());
            }
            Primitive::Path(path) => {
                path.order = order;
                path.id = PathId(self.paths.len());
                self.paths.push(path.clone());
            }
            Primitive::Underline(underline) => {
                underline.order = order;
                self.underlines.push(underline.clone());
            }
            Primitive::MonochromeSprite(sprite) => {
                sprite.order = order;
                self.monochrome_sprites.push(sprite.clone());
            }
            Primitive::PolychromeSprite(sprite) => {
                sprite.order = order;
                self.polychrome_sprites.push(sprite.clone());
            }
            Primitive::Surface(surface) => {
                surface.order = order;
                self.surfaces.push(surface.clone());
            }
        }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));
        self.operation_masks.push(self.mask_id);
        Inserted::Drawn
    }

    /// mirin: upstream's `replay`, also for a retained subtree's drawing
    /// that moved (`elements::retained`), and keeping `operation_masks` in
    /// step. With `offset`, every primitive is moved by it; `mask` gives, for a
    /// primitive's content mask in the previous frame, its place in this
    /// frame's list and, when it changed, the mask itself. A primitive that
    /// is hidden where it lands is kept, hidden, and one that was hidden is
    /// drawn where it now shows.
    ///
    /// `whole`: the same primitives show as did, each as much of it (the
    /// drawing is where it was, or nothing around it clips it before or
    /// after). They are then replayed as one: they keep their draw order
    /// among themselves, above what was drawn under their bounds, instead
    /// of each being placed among everything drawn so far (most of a
    /// replay's time). What overlaps is painted in the same order either
    /// way; only the order's numbers differ.
    pub fn replay_moved(
        &mut self,
        range: Range<usize>,
        prev_scene: &Scene,
        offset: Option<Point<ScaledPixels>>,
        mask: impl Fn(u32) -> (u32, Option<ContentMask<ScaledPixels>>),
        whole: bool,
    ) {
        let outer = self.mask_id;
        let operations = &prev_scene.paint_operations[range.clone()];
        let masks = &prev_scene.operation_masks[range];
        let placed = |primitive: &Primitive, old_mask: u32| {
            let mut primitive = primitive.clone();
            if let Some(offset) = offset {
                primitive.move_by(offset);
            }
            if let Some(content_mask) = mask(old_mask).1 {
                primitive.set_content_mask(content_mask);
            }
            primitive
        };
        // As one: where they all show, and the span of their draw orders.
        let mut unit: Option<(Bounds<ScaledPixels>, DrawOrder, DrawOrder)> = None;
        if whole && self.layer_stack.is_empty() {
            for (operation, old_mask) in operations.iter().zip(masks) {
                let PaintOperation::Primitive(primitive) = operation else {
                    continue;
                };
                let order = primitive.order();
                if order == 0 {
                    continue;
                }
                let mut bounds = *primitive.bounds();
                if let Some(offset) = offset {
                    bounds.origin += offset;
                }
                let shown = match mask(*old_mask).1 {
                    Some(content_mask) => bounds.intersect(&content_mask.bounds),
                    None => bounds.intersect(&primitive.content_mask().bounds),
                };
                unit = Some(match unit {
                    Some((bounds, first, last)) => {
                        (bounds.union(&shown), first.min(order), last.max(order))
                    }
                    None => (shown, order, order),
                });
            }
        }
        let rebase = match unit {
            Some((bounds, first, last)) if whole => {
                let base = self.primitive_bounds.insert_spanning(bounds, last - first);
                Some((base, first))
            }
            _ => None,
        };
        let as_one = whole && self.layer_stack.is_empty();
        for (operation, old_mask) in operations.iter().zip(masks) {
            let (mask_id, content_mask) = mask(*old_mask);
            self.mask_id = mask_id;
            match operation {
                PaintOperation::Primitive(primitive) => {
                    let primitive = placed(primitive, *old_mask);
                    match rebase {
                        Some((base, first)) if primitive.order() != 0 => {
                            let order = base + (primitive.order() - first);
                            self.push_ordered(primitive, order);
                        }
                        _ if as_one => {
                            // Hidden as it was.
                            self.paint_operations
                                .push(PaintOperation::Primitive(primitive));
                            self.operation_masks.push(mask_id);
                        }
                        _ => {
                            self.insert(primitive, true);
                        }
                    }
                }
                PaintOperation::StartLayer {
                    bounds,
                    content_mask: old_mask,
                } => {
                    let mut bounds = *bounds;
                    if let Some(offset) = offset {
                        bounds.origin += offset;
                    }
                    let content_mask = content_mask.unwrap_or_else(|| old_mask.clone());
                    if as_one {
                        // Its primitives carry its order already.
                        self.paint_operations.push(PaintOperation::StartLayer {
                            bounds,
                            content_mask,
                        });
                        self.operation_masks.push(mask_id);
                    } else {
                        let clipped = bounds.intersect(&content_mask.bounds);
                        self.start_layer(bounds, content_mask, clipped, true);
                    }
                }
                PaintOperation::EndLayer => {
                    if as_one {
                        self.paint_operations.push(PaintOperation::EndLayer);
                        self.operation_masks.push(mask_id);
                    } else {
                        self.pop_layer();
                    }
                }
            }
        }
        self.mask_id = outer;
    }

    /// mirin: put a primitive in the scene at a draw order already worked
    /// out (`replay_moved`).
    fn push_ordered(&mut self, mut primitive: Primitive, order: DrawOrder) {
        primitive.set_order(order);
        match &mut primitive {
            Primitive::Shadow(shadow) => self.shadows.push(shadow.clone()),
            Primitive::Quad(quad) => self.quads.push(quad.clone()),
            Primitive::Path(path) => {
                path.id = PathId(self.paths.len());
                self.paths.push(path.clone());
            }
            Primitive::Underline(underline) => self.underlines.push(underline.clone()),
            Primitive::MonochromeSprite(sprite) => self.monochrome_sprites.push(sprite.clone()),
            Primitive::PolychromeSprite(sprite) => self.polychrome_sprites.push(sprite.clone()),
            Primitive::Surface(surface) => self.surfaces.push(surface.clone()),
        }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));
        self.operation_masks.push(self.mask_id);
    }

    /// mirin: every primitive the scene draws so far (not the hidden ones
    /// it keeps), described without its draw order (`Window::scene_digest`).
    pub(crate) fn describe(&self) -> Vec<String> {
        self.paint_operations
            .iter()
            .filter_map(|operation| match operation {
                PaintOperation::Primitive(primitive) => Some(primitive),
                _ => None,
            })
            .filter(|primitive| {
                !primitive
                    .bounds()
                    .intersect(&primitive.content_mask().bounds)
                    .is_empty()
            })
            .map(Primitive::describe)
            .collect()
    }

    /// mirin: what the finished scene paints over what, whatever numbers
    /// the draw orders are: per primitive, what it is and the primitives
    /// painted before it that it overlaps, sorted. Two scenes with the same
    /// answer paint the same pixels (`elements::retained`'s tests).
    #[cfg(test)]
    pub(crate) fn stacking(&self) -> Vec<String> {
        let mut painted: Vec<Primitive> = Vec::new();
        for batch in self.batches() {
            match batch {
                PrimitiveBatch::Shadows(shadows) => {
                    painted.extend(shadows.iter().cloned().map(Primitive::Shadow))
                }
                PrimitiveBatch::Quads(quads) => {
                    painted.extend(quads.iter().cloned().map(Primitive::Quad))
                }
                PrimitiveBatch::Paths(paths) => {
                    painted.extend(paths.iter().cloned().map(Primitive::Path))
                }
                PrimitiveBatch::Underlines(underlines) => {
                    painted.extend(underlines.iter().cloned().map(Primitive::Underline))
                }
                PrimitiveBatch::MonochromeSprites { sprites, .. } => {
                    painted.extend(sprites.iter().cloned().map(Primitive::MonochromeSprite))
                }
                PrimitiveBatch::PolychromeSprites { sprites, .. } => {
                    painted.extend(sprites.iter().cloned().map(Primitive::PolychromeSprite))
                }
                PrimitiveBatch::Surfaces(surfaces) => {
                    painted.extend(surfaces.iter().cloned().map(Primitive::Surface))
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
            .sort_by_key(|sprite| (sprite.order, sprite.tile.tile_id));
        self.polychrome_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.tile_id));
        self.surfaces.sort_by_key(|surface| surface.order);
    }

    #[cfg_attr(
        all(
            any(target_os = "linux", target_os = "freebsd"),
            not(any(feature = "x11", feature = "wayland"))
        ),
        allow(dead_code)
    )]
    pub(crate) fn batches(&self) -> impl Iterator<Item = PrimitiveBatch<'_>> {
        BatchIterator {
            shadows: &self.shadows,
            shadows_start: 0,
            shadows_iter: self.shadows.iter().peekable(),
            quads: &self.quads,
            quads_start: 0,
            quads_iter: self.quads.iter().peekable(),
            paths: &self.paths,
            paths_start: 0,
            paths_iter: self.paths.iter().peekable(),
            underlines: &self.underlines,
            underlines_start: 0,
            underlines_iter: self.underlines.iter().peekable(),
            monochrome_sprites: &self.monochrome_sprites,
            monochrome_sprites_start: 0,
            monochrome_sprites_iter: self.monochrome_sprites.iter().peekable(),
            polychrome_sprites: &self.polychrome_sprites,
            polychrome_sprites_start: 0,
            polychrome_sprites_iter: self.polychrome_sprites.iter().peekable(),
            surfaces: &self.surfaces,
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
    PolychromeSprite,
    Surface,
}

/// mirin: what `Scene::insert_primitive` did with a primitive.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Inserted {
    /// In the scene.
    Drawn,
    /// Its content mask hides it; kept as a paint operation (`Scene::keep`).
    Hidden,
    /// Its content mask hides it; not kept.
    Dropped,
}

// mirin: `Clone`, for a retained subtree's drawing put aside
// (`elements::retained::Parked`).
#[derive(Clone)]
pub(crate) enum PaintOperation {
    Primitive(Primitive),
    // mirin: the layer's bounds as given and its content mask (`Scene::push_layer`).
    StartLayer {
        bounds: Bounds<ScaledPixels>,
        content_mask: ContentMask<ScaledPixels>,
    },
    EndLayer,
}

#[derive(Clone)]
pub(crate) enum Primitive {
    Shadow(Shadow),
    Quad(Quad),
    Path(Path<ScaledPixels>),
    Underline(Underline),
    MonochromeSprite(MonochromeSprite),
    PolychromeSprite(PolychromeSprite),
    Surface(PaintSurface),
}

impl Primitive {
    pub fn bounds(&self) -> &Bounds<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.bounds,
            Primitive::Quad(quad) => &quad.bounds,
            Primitive::Path(path) => &path.bounds,
            Primitive::Underline(underline) => &underline.bounds,
            Primitive::MonochromeSprite(sprite) => &sprite.bounds,
            Primitive::PolychromeSprite(sprite) => &sprite.bounds,
            Primitive::Surface(surface) => &surface.bounds,
        }
    }

    pub fn content_mask(&self) -> &ContentMask<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.content_mask,
            Primitive::Quad(quad) => &quad.content_mask,
            Primitive::Path(path) => &path.content_mask,
            Primitive::Underline(underline) => &underline.content_mask,
            Primitive::MonochromeSprite(sprite) => &sprite.content_mask,
            Primitive::PolychromeSprite(sprite) => &sprite.content_mask,
            Primitive::Surface(surface) => &surface.content_mask,
        }
    }

    /// mirin: what is drawn, apart from its draw order and where its
    /// sprite sits in the atlas (`Window::scene_digest`).
    fn describe(&self) -> String {
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
                // Which subpixel variant of the glyph it is (`pad`, see
                // `Window::paint_line_glyph`), only when asked: a scene
                // described so is told from one described without it.
                if !(cfg!(test) || GLYPH_VARIANTS.load(std::sync::atomic::Ordering::Relaxed)) {
                    sprite_.pad = 0;
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

    // mirin: the draw order it was given (0: none, it is not drawn).
    fn order(&self) -> DrawOrder {
        match self {
            Primitive::Shadow(shadow) => shadow.order,
            Primitive::Quad(quad) => quad.order,
            Primitive::Path(path) => path.order,
            Primitive::Underline(underline) => underline.order,
            Primitive::MonochromeSprite(sprite) => sprite.order,
            Primitive::PolychromeSprite(sprite) => sprite.order,
            Primitive::Surface(surface) => surface.order,
        }
    }

    fn set_order(&mut self, order: DrawOrder) {
        match self {
            Primitive::Shadow(shadow) => shadow.order = order,
            Primitive::Quad(quad) => quad.order = order,
            Primitive::Path(path) => path.order = order,
            Primitive::Underline(underline) => underline.order = order,
            Primitive::MonochromeSprite(sprite) => sprite.order = order,
            Primitive::PolychromeSprite(sprite) => sprite.order = order,
            Primitive::Surface(surface) => surface.order = order,
        }
    }

    // mirin: for a retained subtree's drawing replayed elsewhere (`Scene::replay_moved`).
    fn set_content_mask(&mut self, content_mask: ContentMask<ScaledPixels>) {
        match self {
            Primitive::Shadow(shadow) => shadow.content_mask = content_mask,
            Primitive::Quad(quad) => quad.content_mask = content_mask,
            Primitive::Path(path) => path.content_mask = content_mask,
            Primitive::Underline(underline) => underline.content_mask = content_mask,
            Primitive::MonochromeSprite(sprite) => sprite.content_mask = content_mask,
            Primitive::PolychromeSprite(sprite) => sprite.content_mask = content_mask,
            Primitive::Surface(surface) => surface.content_mask = content_mask,
        }
    }

    // mirin: its bounds and content mask settled on the device grid
    // (`elements::retained::Grid`); whether its position is on it across
    // and down. A path's points are where they were worked out: one drawn
    // where scaling is not exact is never on it.
    pub(crate) fn settle(&mut self, grid: &crate::elements::retained::Grid) -> [bool; 2] {
        let (bounds, content_mask) = match self {
            Primitive::Shadow(shadow) => (&mut shadow.bounds, &mut shadow.content_mask),
            Primitive::Quad(quad) => (&mut quad.bounds, &mut quad.content_mask),
            Primitive::Path(path) => (&mut path.bounds, &mut path.content_mask),
            Primitive::Underline(underline) => (&mut underline.bounds, &mut underline.content_mask),
            Primitive::MonochromeSprite(sprite) => (&mut sprite.bounds, &mut sprite.content_mask),
            Primitive::PolychromeSprite(sprite) => (&mut sprite.bounds, &mut sprite.content_mask),
            Primitive::Surface(surface) => (&mut surface.bounds, &mut surface.content_mask),
        };
        let (settled, on) = grid.settle_device(*bounds);
        *bounds = settled;
        content_mask.bounds = grid.settle_device(content_mask.bounds).0;
        if matches!(self, Primitive::Path(_)) && !grid.is_exact() {
            return [false; 2];
        }
        on
    }

    // mirin: the primitive where it is drawn `offset` away (whole device pixels).
    fn move_by(&mut self, offset: Point<ScaledPixels>) {
        match self {
            Primitive::Shadow(shadow) => shadow.bounds.origin += offset,
            Primitive::Quad(quad) => quad.bounds.origin += offset,
            Primitive::Path(path) => {
                path.bounds.origin += offset;
                for vertex in &mut path.vertices {
                    vertex.xy_position += offset;
                }
            }
            Primitive::Underline(underline) => underline.bounds.origin += offset,
            Primitive::MonochromeSprite(sprite) => sprite.bounds.origin += offset,
            Primitive::PolychromeSprite(sprite) => sprite.bounds.origin += offset,
            Primitive::Surface(surface) => surface.bounds.origin += offset,
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
    shadows: &'a [Shadow],
    shadows_start: usize,
    shadows_iter: Peekable<slice::Iter<'a, Shadow>>,
    quads: &'a [Quad],
    quads_start: usize,
    quads_iter: Peekable<slice::Iter<'a, Quad>>,
    paths: &'a [Path<ScaledPixels>],
    paths_start: usize,
    paths_iter: Peekable<slice::Iter<'a, Path<ScaledPixels>>>,
    underlines: &'a [Underline],
    underlines_start: usize,
    underlines_iter: Peekable<slice::Iter<'a, Underline>>,
    monochrome_sprites: &'a [MonochromeSprite],
    monochrome_sprites_start: usize,
    monochrome_sprites_iter: Peekable<slice::Iter<'a, MonochromeSprite>>,
    polychrome_sprites: &'a [PolychromeSprite],
    polychrome_sprites_start: usize,
    polychrome_sprites_iter: Peekable<slice::Iter<'a, PolychromeSprite>>,
    surfaces: &'a [PaintSurface],
    surfaces_start: usize,
    surfaces_iter: Peekable<slice::Iter<'a, PaintSurface>>,
}

impl<'a> Iterator for BatchIterator<'a> {
    type Item = PrimitiveBatch<'a>;

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
                Some(PrimitiveBatch::Shadows(
                    &self.shadows[shadows_start..shadows_end],
                ))
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
                Some(PrimitiveBatch::Quads(&self.quads[quads_start..quads_end]))
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
                Some(PrimitiveBatch::Paths(&self.paths[paths_start..paths_end]))
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
                Some(PrimitiveBatch::Underlines(
                    &self.underlines[underlines_start..underlines_end],
                ))
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
                    sprites: &self.monochrome_sprites[sprites_start..sprites_end],
                })
            }
            PrimitiveKind::PolychromeSprite => {
                let texture_id = self.polychrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.polychrome_sprites_start;
                let mut sprites_end = self.polychrome_sprites_start + 1;
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
                    sprites: &self.polychrome_sprites[sprites_start..sprites_end],
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
                Some(PrimitiveBatch::Surfaces(
                    &self.surfaces[surfaces_start..surfaces_end],
                ))
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
pub(crate) enum PrimitiveBatch<'a> {
    Shadows(&'a [Shadow]),
    Quads(&'a [Quad]),
    Paths(&'a [Path<ScaledPixels>]),
    Underlines(&'a [Underline]),
    MonochromeSprites {
        texture_id: AtlasTextureId,
        sprites: &'a [MonochromeSprite],
    },
    PolychromeSprites {
        texture_id: AtlasTextureId,
        sprites: &'a [PolychromeSprite],
    },
    Surfaces(&'a [PaintSurface]),
}

#[derive(Default, Debug, Clone)]
#[repr(C)]
pub(crate) struct Quad {
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

#[derive(Debug, Clone)]
#[repr(C)]
pub(crate) struct Underline {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub thickness: ScaledPixels,
    pub wavy: u32,
}

impl From<Underline> for Primitive {
    fn from(underline: Underline) -> Self {
        Primitive::Underline(underline)
    }
}

#[derive(Debug, Clone)]
#[repr(C)]
pub(crate) struct Shadow {
    pub order: DrawOrder,
    pub blur_radius: ScaledPixels,
    pub bounds: Bounds<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
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
    pub fn translate(mut self, point: Point<ScaledPixels>) -> Self {
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

/// mirin: whether a scene's description (`Window::scene_drawn`) says which
/// subpixel variant each glyph is (`describe_glyph_variants`).
static GLYPH_VARIANTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// mirin: make a scene's description (`Window::scene_drawn`) say which
/// subpixel variant each glyph is drawn as: for checking that a glyph moved
/// with a retained subtree is the one drawing it there gives. A scene
/// described so differs from one described without it.
#[doc(hidden)]
pub fn describe_glyph_variants(on: bool) {
    GLYPH_VARIANTS.store(on, std::sync::atomic::Ordering::Relaxed);
}

#[derive(Clone, Debug)]
#[repr(C)]
pub(crate) struct MonochromeSprite {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub tile: AtlasTile,
    pub transformation: TransformationMatrix,
}

impl From<MonochromeSprite> for Primitive {
    fn from(sprite: MonochromeSprite) -> Self {
        Primitive::MonochromeSprite(sprite)
    }
}

#[derive(Clone, Debug)]
#[repr(C)]
pub(crate) struct PolychromeSprite {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub grayscale: bool,
    pub opacity: f32,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub tile: AtlasTile,
}

impl From<PolychromeSprite> for Primitive {
    fn from(sprite: PolychromeSprite) -> Self {
        Primitive::PolychromeSprite(sprite)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PaintSurface {
    pub order: DrawOrder,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    #[cfg(target_os = "macos")]
    pub image_buffer: core_video::pixel_buffer::CVPixelBuffer,
}

impl From<PaintSurface> for Primitive {
    fn from(surface: PaintSurface) -> Self {
        Primitive::Surface(surface)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PathId(pub(crate) usize);

/// A line made up of a series of vertices and control points.
#[derive(Clone, Debug)]
pub struct Path<P: Clone + Debug + Default + PartialEq> {
    pub(crate) id: PathId,
    pub(crate) order: DrawOrder,
    pub(crate) bounds: Bounds<P>,
    pub(crate) content_mask: ContentMask<P>,
    pub(crate) vertices: Vec<PathVertex<P>>,
    pub(crate) color: Background,
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
    pub(crate) fn clipped_bounds(&self) -> Bounds<T> {
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
pub(crate) struct PathVertex<P: Clone + Debug + Default + PartialEq> {
    pub(crate) xy_position: Point<P>,
    pub(crate) st_position: Point<f32>,
    pub(crate) content_mask: ContentMask<P>,
}

impl PathVertex<Pixels> {
    pub fn scale(&self, factor: f32) -> PathVertex<ScaledPixels> {
        PathVertex {
            xy_position: self.xy_position.scale(factor),
            st_position: self.st_position,
            content_mask: self.content_mask.scale(factor),
        }
    }
}
