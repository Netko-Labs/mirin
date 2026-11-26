//! mirin: a window's glass on Wayland. The panes its elements painted in a
//! frame (`Scene::glass`) are sent just before that frame is presented, so
//! the commit that shows the frame carries them too: the blur region
//! (`ext-background-effect-v1`, the union of the panes with their corners cut
//! in steps) and, for each pane, its exact radius and material level
//! (Dashi's `dashi_glass_v1`, `dashi.rs`; the XML is dashi-comp's,
//! `crates/dashi-comp/protocols/`). A panel that grows never shows glass a
//! frame behind its content. A pane something clips (a list scrolled past
//! it) is sent whole and cut to what shows (`cut_pane`, version 3), so the
//! compositor cuts it straight there instead of rounding the part that shows
//! as a pane of its own (which read as a squashed card); an older Dashi gets
//! the part that shows, as before.
//!
//! Panes are sent only where both protocols are and the compositor says it
//! blurs; otherwise nothing is bound or sent. The app leaves its fills out
//! (`Window::is_glass_available`) only once the compositor said it draws this
//! surface's panes (`drawing`): until then, and when the person turned glass
//! off for the app, it paints them. Nothing is sent while the panes stay the
//! same: the compositor keeps double-buffered state until it is set again.

use sumi::{Bounds, Corners, GlassMaterial, GlassPane, Pixels, Size, point, px, size};
use wayland_client::WEnum;
use wayland_client::protocol::wl_surface::WlSurface;
use wayland_protocols::ext::background_effect::v1::client::ext_background_effect_manager_v1::Capability;
use wayland_protocols::ext::background_effect::v1::client::ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1;

use super::client::Globals;
use super::dashi::GlassPanes;
use super::window::add_rounded_rect;

/// The most panes a commit may carry, and the largest radius, as the
/// protocol says (more is a protocol error).
const MOST_PANES: usize = 16;
const MOST_RADIUS: i32 = 512;

/// A pane as `dashi_glass_v1.add_pane` sends it: whole surface-local
/// logical pixels, its radius held to half its shorter side; and what of it
/// shows (`cut_pane`), when that is less than all of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct WirePane {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: i32,
    pub(super) height: i32,
    pub(super) radius: u32,
    /// The protocol's `level` enum's value.
    pub(super) level: u32,
    pub(super) cut: Option<Bounds<i32>>,
}

impl WirePane {
    fn bounds(&self) -> Bounds<i32> {
        Bounds::new(point(self.x, self.y), size(self.width, self.height))
    }
}

/// `bounds` in whole pixels, each edge rounded to the nearest (so two panes
/// that touch still touch and never overlap).
fn whole(bounds: Bounds<Pixels>) -> Bounds<i32> {
    let edge = |value: Pixels| f32::from(value).round() as i32;
    let (left, top) = (edge(bounds.left()), edge(bounds.top()));
    let (right, bottom) = (edge(bounds.right()), edge(bounds.bottom()));
    Bounds::new(point(left, top), size(right - left, bottom - top))
}

/// `a` and `b`'s overlap; none when they don't.
fn overlap(a: Bounds<i32>, b: Bounds<i32>) -> Option<Bounds<i32>> {
    let (left, top) = (a.origin.x.max(b.origin.x), a.origin.y.max(b.origin.y));
    let right = (a.origin.x + a.size.width).min(b.origin.x + b.size.width);
    let bottom = (a.origin.y + a.size.height).min(b.origin.y + b.size.height);
    (right > left && bottom > top)
        .then(|| Bounds::new(point(left, top), size(right - left, bottom - top)))
}

/// The protocol's number for `material` (its `level` enum).
fn level_number(material: GlassMaterial) -> u32 {
    match material {
        GlassMaterial::Thin => 0,
        GlassMaterial::Regular => 1,
        GlassMaterial::Thick => 2,
        GlassMaterial::Paper => 3,
        GlassMaterial::Veil => 4,
    }
}

/// The panes on a surface of `surface` size, in whole pixels; a pane that
/// shows nothing on the surface is dropped. With `cuts` (the compositor has
/// `cut_pane`) each is its whole shape, cut to what shows of it when that is
/// less; without, the part that shows, as a pane of its own. The first 16
/// (the backmost) are kept: a commit takes no more.
pub(super) fn wire_panes(panes: &[GlassPane], surface: Size<Pixels>, cuts: bool) -> Vec<WirePane> {
    let on_surface = whole(Bounds::new(point(px(0.0), px(0.0)), surface));
    panes
        .iter()
        .filter_map(|pane| {
            let shows = overlap(whole(pane.bounds), on_surface)?;
            let shape = if cuts { whole(pane.shape) } else { shows };
            let radius = f32::from(pane.corner_radius).round().max(0.0) as i32;
            let (width, height) = (shape.size.width, shape.size.height);
            Some(WirePane {
                x: shape.origin.x,
                y: shape.origin.y,
                width,
                height,
                radius: radius.min(width / 2).min(height / 2).min(MOST_RADIUS) as u32,
                level: level_number(pane.material),
                cut: (shows != shape).then_some(shows),
            })
        })
        .take(MOST_PANES)
        .collect()
}

/// The blur region's rectangles for `panes`: each pane with its corners cut
/// in one-pixel steps (as the whole-window blur does), within what shows of
/// it, back to back.
pub(super) fn region_rects(panes: &[WirePane], mut add: impl FnMut(i32, i32, i32, i32)) {
    for pane in panes {
        add_rounded_rect(
            pane.bounds(),
            Corners::all(px(pane.radius as f32)),
            |x, y, width, height| {
                let row = Bounds::new(point(x, y), size(width, height));
                let kept = pane.cut.map_or(Some(row), |cut| overlap(row, cut));
                if let Some(kept) = kept {
                    add(
                        kept.origin.x,
                        kept.origin.y,
                        kept.size.width,
                        kept.size.height,
                    );
                }
            },
        );
    }
}

/// Whether the compositor cuts a pane to what shows (`cut_pane`, dashi-chrome-v1 version 3).
pub(super) fn cuts(globals: &Globals) -> bool {
    globals
        .chrome_manager
        .as_ref()
        .is_some_and(|manager| dashi_cuts(manager))
}

#[cfg(feature = "dashi")]
fn dashi_cuts(manager: &super::dashi::ChromeManager) -> bool {
    use wayland_client::Proxy;
    manager.version() >= 3
}

#[cfg(not(feature = "dashi"))]
fn dashi_cuts(manager: &super::dashi::ChromeManager) -> bool {
    match *manager {}
}

/// What a window has sent of its glass, and the object that sends the panes.
#[derive(Default)]
pub(super) struct WindowGlass {
    panes: Option<GlassPanes>,
    sent: Vec<WirePane>,
    /// The compositor said it draws this surface's panes (`drawing`).
    drawn: bool,
    /// The colour behind the first pane, as the compositor last said (`tone`).
    tone: Option<u32>,
}

/// Whether glass can be drawn for a window on this connection now: Dashi's
/// glass protocol, the background effect, and the compositor's blur.
pub(super) fn supported(globals: &Globals) -> bool {
    globals.background_effects_manager.is_some()
        && globals.blur_capable.get()
        && globals
            .chrome_manager
            .as_ref()
            .is_some_and(|manager| dashi_has_glass(manager))
}

#[cfg(feature = "dashi")]
fn dashi_has_glass(manager: &super::dashi::ChromeManager) -> bool {
    use wayland_client::Proxy;
    manager.version() >= 2
}

#[cfg(not(feature = "dashi"))]
fn dashi_has_glass(manager: &super::dashi::ChromeManager) -> bool {
    match *manager {}
}

impl WindowGlass {
    /// Sends the frame's panes (none when glass is off), when they differ
    /// from what was sent last. Called just before the frame is presented:
    /// its commit applies them.
    pub(super) fn frame(
        &mut self,
        panes: Vec<WirePane>,
        surface: &WlSurface,
        globals: &Globals,
        effects: &mut Option<ExtBackgroundEffectSurfaceV1>,
    ) {
        if panes == self.sent {
            return;
        }
        if panes.is_empty() {
            if let Some(effects) = effects.as_ref() {
                effects.set_blur_region(None);
            }
            if let Some(glass) = &self.panes {
                glass.set(&[]);
            }
            self.sent = panes;
            return;
        }
        let (Some(effects_manager), Some(chrome_manager)) = (
            globals.background_effects_manager.as_ref(),
            globals.chrome_manager.as_ref(),
        ) else {
            return;
        };
        if self.panes.is_none() {
            self.panes = GlassPanes::get(chrome_manager, surface, &globals.qh);
        }
        let Some(glass) = &self.panes else {
            return;
        };
        let effects = effects
            .get_or_insert_with(|| effects_manager.get_background_effect(surface, &globals.qh, ()));
        let region = globals.compositor.create_region(&globals.qh, ());
        region_rects(&panes, |x, y, width, height| {
            region.add(x, y, width, height)
        });
        effects.set_blur_region(Some(&region));
        region.destroy();
        glass.set(&panes);
        self.sent = panes;
    }

    /// Whether the compositor draws this window's panes, as it last said.
    pub(super) fn is_drawn(&self) -> bool {
        self.drawn
    }

    /// What the compositor says now; whether that changed. (Only Dashi's
    /// protocol says it: without the `dashi` feature nothing calls it.)
    #[cfg_attr(not(feature = "dashi"), allow(dead_code))]
    pub(super) fn set_drawn(&mut self, drawn: bool) -> bool {
        std::mem::replace(&mut self.drawn, drawn) != drawn
    }

    /// The colour behind the first pane (`0xRRGGBB`), as the compositor last said.
    pub(super) fn tone(&self) -> Option<u32> {
        self.tone
    }

    /// The compositor's `tone`; whether it changed.
    #[cfg_attr(not(feature = "dashi"), allow(dead_code))]
    pub(super) fn set_tone(&mut self, rgb: u32) -> bool {
        let rgb = rgb & 0xff_ffff;
        self.tone.replace(rgb) != Some(rgb)
    }

    /// Whether the compositor holds panes of this window's now.
    pub(super) fn has_panes(&self) -> bool {
        !self.sent.is_empty()
    }

    /// The whole-window blur took the region: the panes go (in the same
    /// commit as the region), and the next frame without it sends
    /// everything again.
    pub(super) fn yield_region(&mut self) {
        if let (Some(glass), false) = (&self.panes, self.sent.is_empty()) {
            glass.set(&[]);
        }
        self.sent.clear();
    }

    /// Before the surface goes: the glass object first.
    pub(super) fn destroy(&mut self) {
        if let Some(glass) = self.panes.take() {
            glass.destroy();
        }
    }
}

/// The `blur` capability's bit. ext-background-effect-v1 as wayland-protocols
/// 0.32.9 ships it says `value="0"` (a typo upstream fixed later); the
/// protocol, and Dashi, send bit 1.
const BLUR_BIT: u32 = 1;

/// Whether the background effect manager's `capabilities` says it blurs.
/// The bits are read whatever wayland-rs made of them: with the typo above,
/// `capabilities(1)` arrives as `Unknown(1)`, and no window ever had glass.
pub(super) fn blur_capability(flags: WEnum<Capability>) -> bool {
    let bits = match flags {
        WEnum::Value(flags) => flags.bits(),
        WEnum::Unknown(bits) => bits,
    };
    bits & BLUR_BIT != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(x: f32, y: f32, width: f32, height: f32, radius: f32) -> GlassPane {
        let bounds = Bounds::new(point(px(x), px(y)), size(px(width), px(height)));
        GlassPane {
            bounds,
            shape: bounds,
            corner_radius: px(radius),
            material: GlassMaterial::Regular,
        }
    }

    fn wire(x: i32, y: i32, width: i32, height: i32, radius: u32, level: u32) -> WirePane {
        WirePane {
            x,
            y,
            width,
            height,
            radius,
            level,
            cut: None,
        }
    }

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Bounds<i32> {
        Bounds::new(point(x, y), size(width, height))
    }

    const SURFACE: Size<Pixels> = Size {
        width: px(400.0),
        height: px(300.0),
    };

    #[test]
    fn edges_round_to_the_nearest_pixel_so_touching_panes_still_touch() {
        let panes = wire_panes(
            &[
                pane(10.4, 20.6, 99.8, 50.0, 12.0),
                pane(110.2, 20.6, 40.0, 50.0, 0.0),
            ],
            SURFACE,
            false,
        );
        assert_eq!(panes[0], wire(10, 21, 100, 50, 12, 1));
        // The first ends at 110.2 → 110, where the second starts.
        assert_eq!(panes[0].x + panes[0].width, panes[1].x);
    }

    #[test]
    fn panes_are_clipped_to_the_surface_and_empty_ones_dropped() {
        let panes = wire_panes(
            &[
                pane(-20.0, 280.0, 100.0, 50.0, 8.0),
                pane(500.0, 10.0, 50.0, 50.0, 8.0),
                pane(50.0, 50.0, 0.3, 40.0, 0.0),
            ],
            SURFACE,
            false,
        );
        assert_eq!(panes, vec![wire(0, 280, 80, 20, 8, 1)]);
    }

    #[test]
    fn a_clipped_pane_is_sent_whole_and_cut_to_what_shows() {
        // A widget 356 × 160, radius 18, its list cut at y 260: only its top 60 show.
        let card = GlassPane {
            bounds: Bounds::new(point(px(10.0), px(200.0)), size(px(356.0), px(60.0))),
            shape: Bounds::new(point(px(10.0), px(200.0)), size(px(356.0), px(160.0))),
            corner_radius: px(18.0),
            material: GlassMaterial::Paper,
        };
        let panes = wire_panes(&[card], SURFACE, true);
        assert_eq!(
            panes,
            vec![WirePane {
                cut: Some(rect(10, 200, 356, 60)),
                ..wire(10, 200, 356, 160, 18, 3)
            }]
        );
        // The region is the pane's rounded shape within the cut: its top corners round,
        // its foot straight at the cut, nothing below it.
        let mut rows = Vec::new();
        region_rects(&panes, |x, y, width, height| {
            rows.push((x, y, width, height))
        });
        assert!(
            rows.iter()
                .all(|&(_, y, _, height)| y >= 200 && y + height <= 260)
        );
        assert!(
            rows.iter().any(|&(x, y, _, _)| y == 200 && x > 10),
            "a round top corner"
        );
        assert!(
            rows.iter()
                .any(|&(x, y, width, height)| x == 10 && width == 356 && y + height == 260),
            "a straight foot"
        );
        // An older Dashi: the part that shows, as a pane of its own.
        let old = wire_panes(&[card], SURFACE, false);
        assert_eq!(old, vec![wire(10, 200, 356, 60, 18, 3)]);
    }

    #[test]
    fn the_radius_is_at_most_half_the_shorter_side_and_512() {
        let panes = wire_panes(&[pane(0.0, 0.0, 200.0, 30.0, 40.0)], SURFACE, true);
        assert_eq!(panes[0].radius, 15);
        let large = Size {
            width: px(4000.0),
            height: px(3000.0),
        };
        let panes = wire_panes(&[pane(0.0, 0.0, 2000.0, 2000.0, 900.0)], large, true);
        assert_eq!(panes[0].radius, 512);
    }

    #[test]
    fn a_commit_carries_the_backmost_sixteen() {
        let many: Vec<GlassPane> = (0..20)
            .map(|index| pane(index as f32 * 10.0, 0.0, 8.0, 8.0, 0.0))
            .collect();
        let panes = wire_panes(&many, SURFACE, true);
        assert_eq!(panes.len(), 16);
        assert_eq!(panes[0].x, 0);
        assert_eq!(panes[15].x, 150);
    }

    #[test]
    fn every_material_has_its_protocol_level() {
        let numbers: Vec<u32> = [
            GlassMaterial::Thin,
            GlassMaterial::Regular,
            GlassMaterial::Thick,
            GlassMaterial::Paper,
            GlassMaterial::Veil,
        ]
        .into_iter()
        .map(level_number)
        .collect();
        assert_eq!(numbers, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn what_the_compositor_says_is_kept_and_a_change_is_told() {
        let mut glass = WindowGlass::default();
        assert!(!glass.is_drawn(), "no glass until the compositor says so");
        assert!(glass.set_drawn(true));
        assert!(!glass.set_drawn(true));
        assert!(glass.is_drawn());
        assert!(glass.set_drawn(false));
    }

    #[test]
    fn the_region_is_each_pane_with_its_corners_cut() {
        let panes = [wire(10, 10, 20, 10, 0, 1), wire(50, 0, 8, 8, 4, 0)];
        let mut rects = Vec::new();
        region_rects(&panes, |x, y, width, height| {
            rects.push((x, y, width, height))
        });
        assert_eq!(rects[0], (10, 10, 20, 10));
        // The rounded pane: rows cut at its corners, never wider than it,
        // and covering every one of its rows.
        let rounded = &rects[1..];
        assert!(
            rounded
                .iter()
                .all(|&(x, _, width, _)| x >= 50 && x + width <= 58)
        );
        let rows: u32 = rounded.iter().map(|&(_, _, _, height)| height as u32).sum();
        assert_eq!(rows, 8);
        assert!(
            rounded.iter().any(|&(x, y, _, _)| y == 0 && x > 50),
            "a cut corner"
        );
    }

    #[test]
    fn blur_is_read_from_the_bits_whatever_wayland_rs_made_of_them() {
        use super::{WEnum, blur_capability};
        assert!(blur_capability(WEnum::Unknown(1)));
        assert!(blur_capability(WEnum::Unknown(3)));
        assert!(!blur_capability(WEnum::Unknown(0)));
        assert!(!blur_capability(WEnum::Unknown(2)));
    }
}
