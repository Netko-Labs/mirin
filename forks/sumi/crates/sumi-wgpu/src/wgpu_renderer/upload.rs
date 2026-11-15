//! mirin: what the renderer wrote of the scene it last drew, kept so the
//! next frame writes only what changed (`docs/metal/engine.md`, section 3).
//!
//! Every frame used to write every instance of the scene to the GPU's
//! buffer again, make a bind group per list and go over every primitive
//! twice to find its batches, whatever had changed. A window's scene is now
//! kept between frames and edited in place when little changed (a partial
//! frame, `sumi::Scene::damage_since`): the lists are as long as they were,
//! the batches the same, and a few instances differ. Those are written
//! where they sit in the buffer; the bind groups and batches are kept. A
//! frame of another scene, or one whose changes are no longer told, writes
//! everything as before.

use smallvec::SmallVec;
use sumi::{PrimitiveBatch, Scene, SceneList, SceneVersion};

use super::{InstanceBindings, InstanceData, WgpuRendererCore};

/// The lists of a scene a patch can change, in the order of `Uploaded`'s
/// offsets.
const LISTS: [SceneList; 6] = [
    SceneList::Shadows,
    SceneList::Quads,
    SceneList::Underlines,
    SceneList::MonochromeSprites,
    SceneList::SubpixelSprites,
    SceneList::PolychromeSprites,
];

/// What was written for the scene drawn last.
pub(super) struct Uploaded {
    /// Which scene, and how many of its patches.
    version: SceneVersion,
    /// The instance buffer it was written to (`WgpuRendererCore::instance_buffers`).
    buffer: u64,
    pub(super) bindings: InstanceBindings,
    /// Where each of `LISTS` was written (bytes into the buffer), and how
    /// many instances long it is.
    offsets: [u64; 6],
    lens: [usize; 6],
    pub(super) batches: Vec<PrimitiveBatch>,
}

fn lens(scene: &Scene) -> [usize; 6] {
    [
        scene.shadows.len(),
        scene.quads.len(),
        scene.underlines.len(),
        scene.monochrome_sprites.len(),
        scene.subpixel_sprites.len(),
        scene.polychrome_sprites.len(),
    ]
}

impl Uploaded {
    /// `scene` was written whole, with these bindings.
    pub(super) fn new(scene: &Scene, bindings: InstanceBindings, buffer: u64) -> Self {
        let offsets = [
            bindings.shadows.offset,
            bindings.quads.offset,
            bindings.underlines.offset,
            bindings.monochrome_sprites.offset,
            bindings.subpixel_sprites.offset,
            bindings.polychrome_sprites.offset,
        ];
        Self {
            version: scene.version(),
            buffer,
            bindings,
            offsets,
            lens: lens(scene),
            batches: scene.batches().collect(),
        }
    }
}

impl WgpuRendererCore {
    /// Bring what was written for the scene drawn last up to `scene`, when
    /// `scene` is that scene with a few primitives changed: only those are
    /// written. `false`: it is another scene (or more changed than the
    /// scene tells of), and everything is to be written.
    pub(super) fn write_damage(&self, scene: &Scene, uploaded: &mut Uploaded) -> bool {
        if uploaded.buffer != self.instance_buffers || lens(scene) != uploaded.lens {
            return false;
        }
        let InstanceData::Storage(buffer) = &self.resources.instance_data else {
            return false;
        };
        let Some(damage) = scene.damage_since(uploaded.version) else {
            return false;
        };
        // By list, then by slot: runs of slots are written in one go.
        let mut slots: SmallVec<[(usize, u32); 32]> = damage
            .iter()
            .filter_map(|(list, slot)| {
                let list = LISTS.iter().position(|of| of == list)?;
                Some((list, *slot))
            })
            .collect();
        slots.sort_unstable();
        slots.dedup();
        let mut at = 0;
        while at < slots.len() {
            let (list, first) = slots[at];
            let mut last = first;
            at += 1;
            while at < slots.len() && slots[at] == (list, last + 1) {
                last += 1;
                at += 1;
            }
            let (first, end) = (first as usize, last as usize + 1);
            let offset = uploaded.offsets[list];
            let queue = &self.resources.queue;
            let written = match LISTS[list] {
                SceneList::Shadows => write(queue, buffer, offset, &scene.shadows, first, end),
                SceneList::Quads => write(queue, buffer, offset, &scene.quads, first, end),
                SceneList::Underlines => {
                    write(queue, buffer, offset, &scene.underlines, first, end)
                }
                SceneList::MonochromeSprites => {
                    write(queue, buffer, offset, &scene.monochrome_sprites, first, end)
                }
                SceneList::SubpixelSprites => {
                    write(queue, buffer, offset, &scene.subpixel_sprites, first, end)
                }
                SceneList::PolychromeSprites => {
                    write(queue, buffer, offset, &scene.polychrome_sprites, first, end)
                }
            };
            if !written {
                return false;
            }
        }
        uploaded.version = scene.version();
        true
    }
}

/// Write `list[first..end]` where it sits in `buffer`, the list starting at
/// `offset`. `false`: there is no such run.
fn write<T>(
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    offset: u64,
    list: &[T],
    first: usize,
    end: usize,
) -> bool {
    let Some(run) = list.get(first..end) else {
        return false;
    };
    // SAFETY: the scene's primitives are `repr(C)` with no padding, the
    // bytes the whole list was written from (`WgpuRendererCore::instance_bytes`).
    let bytes = unsafe { WgpuRendererCore::instance_bytes(run) };
    let stride = std::mem::size_of::<T>() as u64;
    queue.write_buffer(buffer, offset + first as u64 * stride, bytes);
    true
}
