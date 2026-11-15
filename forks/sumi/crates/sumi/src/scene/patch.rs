//! A scene edited in place (`docs/metal/engine.md`, section 3).
//!
//! A finished scene is what the window keeps between frames. A frame in
//! which only the content of retained subtrees changed (a partial frame,
//! `window/partial.rs`) does not build another: it paints each changed
//! subtree again over the paint operations it drew last, in a patch
//! ([`Scene::begin_patch`] to [`Scene::end_patch`]).
//!
//! What is painted in a patch must have the shape of what it replaces:
//! operation for operation a primitive of the same kind, with the same
//! bounds, content mask, strip and atlas texture, shown or hidden as the
//! one before it was. Its color, its glyph, its corner radii may differ.
//! Then the bounds tree would give it the draw order the one before it had
//! and the sort would leave it where that one is, so it takes both: its
//! order, and its slot in the list of its kind, which every paint operation
//! knows since the scene was finished ([`Slots`]). Nothing is sorted and no
//! other primitive is touched. Where the shape differs the patch fails. It
//! has then written only over operations and slots of the subtree it was
//! painting, and the frame is drawn in full: that builds a scene of its
//! own, with the subtree painted anew and from this one only the drawings
//! of subtrees that did not change, which no patch writes into.
//!
//! A renderer that kept what it uploaded for the scene it last drew asks
//! what changed since ([`Scene::damage_since`]) and writes those instances
//! alone.

use std::{
    ops::Range,
    sync::atomic::{AtomicU64, Ordering},
};

use super::{PaintOperation, Primitive, PrimitiveKind, Scene, Strip};
use crate::window::MaskId;

/// No slot: an operation that is a layer's start or end, or draws a
/// primitive that does not show, or one of a kind that has no slots.
const NO_SLOT: u32 = u32::MAX;

/// The most damage kept before a renderer that has not asked is told
/// everything changed.
const DAMAGE_KEPT: usize = 1 << 14;

static GENERATIONS: AtomicU64 = AtomicU64::new(1);

/// Which finished scene, and how many patches of it, a renderer drew.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SceneVersion {
    generation: u64,
    patches: u64,
}

/// A list of a scene's primitives that a patch can change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(missing_docs)]
pub enum SceneList {
    Shadows,
    Quads,
    Underlines,
    MonochromeSprites,
    SubpixelSprites,
    PolychromeSprites,
}

impl SceneList {
    fn of(kind: PrimitiveKind) -> Option<Self> {
        match kind {
            PrimitiveKind::Shadow => Some(Self::Shadows),
            PrimitiveKind::Quad => Some(Self::Quads),
            PrimitiveKind::Underline => Some(Self::Underlines),
            PrimitiveKind::MonochromeSprite => Some(Self::MonochromeSprites),
            PrimitiveKind::SubpixelSprite => Some(Self::SubpixelSprites),
            PrimitiveKind::PolychromeSprite => Some(Self::PolychromeSprites),
            PrimitiveKind::Path | PrimitiveKind::Surface => None,
        }
    }
}

/// Where the sort put each paint operation's primitive, and what patches
/// changed since.
#[derive(Default)]
pub(super) struct Slots {
    /// Per paint operation: its primitive's index in the list of its kind.
    /// Made when the scene is first patched (`slots`): a scene that is
    /// built anew every frame never needs it.
    of_operation: Vec<u32>,
    /// Per kind, per primitive: the paint operation it came from, in the
    /// order they were pushed, then (`sorted`) in the order of the list.
    sources: [Vec<u32>; 8],
    /// Scratch for `sorted`.
    permuted: Vec<u32>,
    /// The scene's number since it was finished (0: not finished).
    generation: u64,
    patches: u64,
    /// The slots patches changed, oldest first, and where each patch's
    /// begin in it; `damage_from`: the first patch still told of.
    damage: Vec<(SceneList, u32)>,
    damage_starts: Vec<usize>,
    damage_from: u64,
    /// The patch being made.
    patch: Option<Patch>,
}

struct Patch {
    end: usize,
    cursor: usize,
    failed: bool,
    damage: Vec<(SceneList, u32)>,
}

impl Slots {
    pub(super) fn clear(&mut self) {
        self.of_operation.clear();
        for sources in &mut self.sources {
            sources.clear();
        }
        self.generation = 0;
        self.patches = 0;
        self.damage.clear();
        self.damage_starts.clear();
        self.damage_from = 0;
        self.patch = None;
    }

    /// A primitive of `kind` was pushed onto its list, from the paint
    /// operation at `operation`.
    #[inline]
    pub(super) fn pushed(&mut self, kind: PrimitiveKind, operation: usize) {
        self.sources[kind as usize].push(operation as u32);
    }

    /// The scene is about to be sorted.
    pub(super) fn begin_finish(&mut self) {
        self.of_operation.clear();
        self.generation = GENERATIONS.fetch_add(1, Ordering::Relaxed);
        self.patches = 0;
        self.damage.clear();
        self.damage_starts.clear();
        self.damage_from = 0;
    }

    /// The list of `kind`, `len` long, is in the order it was pushed in.
    pub(super) fn kept_order(&mut self, kind: PrimitiveKind, len: usize) {
        if self.sources[kind as usize].len() != len {
            // Something was pushed past `Scene::push_primitive`: no slots,
            // so no patches of this scene.
            self.generation = 0;
        }
    }

    /// The list of `kind` was sorted: the primitive now at `target` was
    /// pushed `keys[target].1`th.
    pub(super) fn sorted(&mut self, kind: PrimitiveKind, keys: &[(u64, u32)]) {
        let sources = &mut self.sources[kind as usize];
        if sources.len() != keys.len() {
            self.generation = 0;
            return;
        }
        self.permuted.clear();
        self.permuted
            .extend(keys.iter().map(|(_, source)| sources[*source as usize]));
        std::mem::swap(sources, &mut self.permuted);
    }

    /// Where each paint operation's primitive is in the list of its kind,
    /// for a scene of `operations` paint operations: worked out the first
    /// time the scene is patched.
    fn slots(&mut self, operations: usize) {
        if self.of_operation.len() == operations {
            return;
        }
        self.of_operation.clear();
        self.of_operation.resize(operations, NO_SLOT);
        for sources in &self.sources {
            for (slot, operation) in sources.iter().enumerate() {
                if let Some(of_operation) = self.of_operation.get_mut(*operation as usize) {
                    *of_operation = slot as u32;
                }
            }
        }
    }
}

impl Scene {
    /// Which scene this is, for [`Self::damage_since`].
    pub fn version(&self) -> SceneVersion {
        SceneVersion {
            generation: self.slots.generation,
            patches: self.slots.patches,
        }
    }

    /// The primitives changed since `drawn` was this scene's version, as
    /// the list each is in and its index there; `None` when it is another
    /// scene, or more changed than is kept: everything is to be taken
    /// anew. An animated sprite changes with the clock, not with a patch.
    pub fn damage_since(&self, drawn: SceneVersion) -> Option<&[(SceneList, u32)]> {
        let slots = &self.slots;
        if slots.generation == 0
            || drawn.generation != slots.generation
            || drawn.patches > slots.patches
            || drawn.patches < slots.damage_from
            || !self.animations.is_empty()
        {
            return None;
        }
        let from = (drawn.patches - slots.damage_from) as usize;
        match slots.damage_starts.get(from) {
            Some(start) => slots.damage.get(*start..),
            None => Some(&[]),
        }
    }

    /// Whether a patch of this scene can be begun: it was finished, and
    /// has no animation (whose sprite the clock moves in its list).
    pub(crate) fn patchable(&self) -> bool {
        self.slots.generation != 0 && self.animations.is_empty()
    }

    /// Whether a patch is being made.
    #[inline]
    pub(crate) fn patching(&self) -> bool {
        self.slots.patch.is_some()
    }

    /// Where the patch being made writes next.
    pub(super) fn patch_cursor(&self) -> Option<usize> {
        self.slots.patch.as_ref().map(|patch| patch.cursor)
    }

    /// Paint over the operations in `range` from here on. `false`: this
    /// scene can't be patched (it was not finished, or has an animation,
    /// whose sprite the clock moves in its list).
    pub(crate) fn begin_patch(&mut self, range: Range<usize>) -> bool {
        if !self.patchable()
            || self.slots.patch.is_some()
            || range.start > range.end
            || range.end > self.paint_operations.len()
            || !self.layer_stack.is_empty()
        {
            return false;
        }
        self.slots.slots(self.paint_operations.len());
        self.slots.patch = Some(Patch {
            end: range.end,
            cursor: range.start,
            failed: false,
            damage: Vec::new(),
        });
        true
    }

    /// The patch can't be what it replaces.
    pub(crate) fn fail_patch(&mut self) {
        if let Some(patch) = &mut self.slots.patch {
            patch.failed = true;
        }
    }

    /// A primitive painted in a patch (a border's strip with `strip`),
    /// under the mask `mask_id`: over the operation the patch is at, when
    /// it is of its shape.
    pub(super) fn patch_operation(
        &mut self,
        mut primitive: Primitive,
        strip: Option<Strip>,
        mask_id: MaskId,
    ) {
        let Some(patch) = &mut self.slots.patch else {
            return;
        };
        let index = patch.cursor;
        patch.cursor += 1;
        if patch.failed || index >= patch.end {
            patch.failed = true;
            return;
        }
        let slot = self.slots.of_operation[index];
        let old = &self.paint_operations[index];
        let same = match (old, &strip) {
            (PaintOperation::Primitive(old, old_mask), None) => {
                *old_mask == mask_id && same_shape(old, &primitive)
            }
            (PaintOperation::Strip(old, old_strip, old_mask), Some(strip)) => {
                *old_mask == mask_id && old_strip == strip && same_shape(old, &primitive)
            }
            _ => false,
        };
        let shows = !primitive.clipped_bounds().is_empty();
        let list = SceneList::of(primitive.kind());
        if !same || shows != (slot != NO_SLOT) || (shows && list.is_none()) {
            patch.failed = true;
            return;
        }
        if let Some(order) = old.primitive().map(Primitive::order) {
            primitive.set_order(order);
        }
        if let Some(list) = list.filter(|_| shows) {
            let at = slot as usize;
            let written = match &primitive {
                Primitive::Shadow(shadow) => write(&mut self.shadows, at, *shadow),
                Primitive::Quad(quad) => write(&mut self.quads, at, *quad),
                Primitive::Underline(underline) => write(&mut self.underlines, at, *underline),
                Primitive::MonochromeSprite(sprite) => {
                    write(&mut self.monochrome_sprites, at, *sprite)
                }
                Primitive::SubpixelSprite(sprite) => write(&mut self.subpixel_sprites, at, *sprite),
                Primitive::PolychromeSprite(sprite) => {
                    write(&mut self.polychrome_sprites, at, *sprite)
                }
                Primitive::Path(_) | Primitive::Surface(_) => false,
            };
            if !written {
                patch.failed = true;
                return;
            }
            patch.damage.push((list, slot));
        }
        self.paint_operations[index] = PaintOperation::of(primitive, strip, mask_id);
    }

    /// A layer starts (or ends) in a patch: where one did.
    pub(super) fn patch_layer(&mut self, start: bool) {
        let Some(patch) = &mut self.slots.patch else {
            return;
        };
        let index = patch.cursor;
        patch.cursor += 1;
        let same = matches!(
            (self.paint_operations.get(index), start),
            (Some(PaintOperation::StartLayer), true) | (Some(PaintOperation::EndLayer), false)
        );
        if index >= patch.end || !same {
            patch.failed = true;
        }
    }

    /// A drawing kept from the frame being patched is where the patch is
    /// (a clean retained subtree inside the one painted again): stepped
    /// over. Unless the caller took it in itself (`absorbed`), the subtree
    /// being recorded takes in how far it reaches.
    pub(crate) fn patch_step_over(&mut self, range: Range<usize>, absorbed: bool) {
        let Some(patch) = &mut self.slots.patch else {
            return;
        };
        if patch.failed || range.start != patch.cursor || range.end > patch.end {
            patch.failed = true;
            return;
        }
        patch.cursor = range.end;
        if absorbed {
            return;
        }
        if let Some(reach) = &mut self.reach {
            for operation in &self.paint_operations[range] {
                if let Some(primitive) = operation.primitive() {
                    reach.take_in(primitive, operation.strip(), false);
                }
            }
        }
    }

    /// End the patch. `keep` it when everything else it was made with held
    /// too; whether it is kept: it painted over exactly its range, shape
    /// for shape, and a renderer is told what it changed.
    pub(crate) fn end_patch(&mut self, keep: bool) -> bool {
        let Some(patch) = self.slots.patch.take() else {
            return false;
        };
        let slots = &mut self.slots;
        if !(keep && !patch.failed && patch.cursor == patch.end) {
            // Whatever it wrote is not told of: no renderer may take this
            // scene for the one it drew.
            slots.generation = 0;
            return false;
        }
        if slots.damage.len() + patch.damage.len() > DAMAGE_KEPT {
            slots.damage.clear();
            slots.damage_starts.clear();
            slots.damage_from = slots.patches + 1;
        } else {
            slots.damage_starts.push(slots.damage.len());
            slots.damage.extend(patch.damage);
        }
        slots.patches += 1;
        true
    }
}

/// Put `primitive` at `slot` of its list; whether there is such a slot.
fn write<T>(list: &mut [T], slot: usize, primitive: T) -> bool {
    match list.get_mut(slot) {
        Some(place) => {
            *place = primitive;
            true
        }
        None => false,
    }
}

/// Whether `new` goes where `old` is in the scene: the bounds tree gives a
/// primitive its draw order from its kind and what of it shows, and the
/// sort places it by that order and its atlas texture.
fn same_shape(old: &Primitive, new: &Primitive) -> bool {
    let texture = |primitive: &Primitive| match primitive {
        Primitive::MonochromeSprite(sprite) => Some(sprite.tile.texture_id),
        Primitive::SubpixelSprite(sprite) => Some(sprite.tile.texture_id),
        Primitive::PolychromeSprite(sprite) => Some(sprite.tile.texture_id),
        _ => None,
    };
    // A sprite that is turned is pinned where it is (`SceneReach`): as it
    // was.
    let turned = |primitive: &Primitive| match primitive {
        Primitive::MonochromeSprite(sprite) => Some(sprite.transformation),
        Primitive::SubpixelSprite(sprite) => Some(sprite.transformation),
        _ => None,
    };
    old.kind() == new.kind()
        && old.bounds() == new.bounds()
        && old.content_mask() == new.content_mask()
        && old.clipped_bounds() == new.clipped_bounds()
        && texture(old) == texture(new)
        && turned(old) == turned(new)
}
