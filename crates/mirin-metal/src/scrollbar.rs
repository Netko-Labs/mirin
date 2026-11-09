//! Overlay scroll bars, as macOS draws them: a thin rounded thumb along a
//! scroll view's right edge (and along its bottom edge, for a view that
//! scrolls across) while its content is longer than it, at the scroll
//! position. GPUI draws none of its own.
//!
//! A bar hides itself. It shows while the view scrolls and while the pointer
//! is near its edge, stays a moment, then fades out. While it shows it is a
//! real scroll bar: the thumb can be dragged, and a press on the track beside
//! the thumb pages. Hidden, it takes nothing: presses and hovers go to the
//! content under it, so it never covers anything for good.
//!
//! The bar is painted, not laid out: a zero-size canvas that, when it
//! prepaints, reads the view's geometry (already laid out this frame), puts
//! its hit area along the edge, and paints over the viewport. A laid-out
//! child would count toward the content's length and, following the scroll,
//! let it scroll forever.

use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{
    canvas, fill, point, px, rgba, size, AnyElement, App, Bounds, DispatchPhase, Hitbox,
    HitboxBehavior, IntoElement, ListState, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, ScrollHandle, Styled, Window,
};

/// How long a bar stays after the last scroll (or after the pointer left
/// it), and how long it fades.
const SHOWN: Duration = Duration::from_millis(900);
const FADE: Duration = Duration::from_millis(300);

/// The thumb's thickness at rest, and under the pointer or held (px).
const WIDTH: f32 = 6.0;
const WIDE: f32 = 8.0;
/// Its gap to the view's edge and to the track's ends.
const INSET: f32 = 3.0;
/// The band along the edge where the pointer shows the bar, and where a
/// shown bar takes presses: the thumb's width and its gaps, and a little
/// more so it is easy to reach.
const BAND: f32 = 14.0;
/// The shortest a thumb gets.
const MIN_LENGTH: f32 = 28.0;
/// A page is the view's length less this, so the line at the edge stays in
/// sight.
const PAGE_OVERLAP: f32 = 24.0;
/// Gray at half strength: it reads on true-black Dark and on Light alike.
/// Stronger under the pointer, and a faint track behind it then.
const COLOR: u32 = 0x8080_8090;
const COLOR_HELD: u32 = 0x8080_80c0;
const TRACK: u32 = 0x8080_8022;

/// Which way a bar runs: along the right edge (`Vertical`) or the bottom one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Axis {
    Vertical,
    Horizontal,
}

/// What a bar scrolls: a scroll view, by its handle, or a virtualized list.
#[derive(Clone)]
pub(crate) enum Scrolled {
    View(ScrollHandle),
    List(ListState),
}

/// A view's geometry this frame: its box in the window, how far its content
/// overflows it each way, and how far it is scrolled each way (both >= 0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Geometry {
    pub(crate) viewport: Bounds<Pixels>,
    pub(crate) overflow: (f32, f32),
    pub(crate) scrolled: (f32, f32),
}

impl Scrolled {
    fn geometry(&self) -> Geometry {
        match self {
            Scrolled::View(handle) => {
                let max = handle.max_offset();
                // GPUI's offsets are negative as the content moves up and left.
                let offset = handle.offset();
                Geometry {
                    viewport: handle.bounds(),
                    overflow: (f32::from(max.width), f32::from(max.height)),
                    scrolled: (-f32::from(offset.x), -f32::from(offset.y)),
                }
            }
            Scrolled::List(state) => Geometry {
                viewport: state.viewport_bounds(),
                overflow: (0.0, f32::from(state.max_offset_for_scrollbar().height)),
                scrolled: (0.0, -f32::from(state.scroll_px_offset_for_scrollbar().y)),
            },
        }
    }

    /// Scroll along `axis` to `value` (how far from the start), in range.
    fn scroll_to(&self, axis: Axis, value: f32) {
        let geometry = self.geometry();
        let max = match axis {
            Axis::Vertical => geometry.overflow.1,
            Axis::Horizontal => geometry.overflow.0,
        };
        let value = value.clamp(0.0, max.max(0.0));
        match self {
            Scrolled::View(handle) => {
                let offset = handle.offset();
                handle.set_offset(match axis {
                    Axis::Vertical => point(offset.x, px(-value)),
                    Axis::Horizontal => point(px(-value), offset.y),
                });
            }
            Scrolled::List(state) => {
                if axis == Axis::Vertical {
                    state.set_offset_from_scrollbar(point(px(0.0), px(-value)));
                }
            }
        }
    }

    fn grabbed(&self) {
        if let Scrolled::List(state) = self {
            state.scrollbar_drag_started();
        }
    }

    fn let_go(&self) {
        if let Scrolled::List(state) = self {
            state.scrollbar_drag_ended();
        }
    }
}

/// A thumb held by the pointer: along which bar, and how far into the thumb
/// the pointer took it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Held {
    axis: Axis,
    grab: f32,
}

/// What one view's bars remember between frames.
#[derive(Default)]
struct BarState {
    /// Where the view was last seen scrolled.
    seen: Option<(f32, f32)>,
    /// When it last scrolled, or the pointer last left or let go of a bar.
    shown_at: Option<Instant>,
    /// The bar the pointer is near, if any.
    near: Option<Axis>,
    held: Option<Held>,
}

/// One view's bars' state (kept by id in the root view).
#[derive(Clone, Default)]
pub(crate) struct Activity(Rc<RefCell<BarState>>);

impl Activity {
    /// Note the scroll position now; how visible the bars are (0 to 1).
    fn visibility(&self, scrolled: (f32, f32), now: Instant) -> f32 {
        let mut state = self.0.borrow_mut();
        match state.seen {
            // The first look is not a scroll: a view does not open with its bar showing.
            None => {}
            Some(seen)
                if (seen.0 - scrolled.0).abs() > 0.5 || (seen.1 - scrolled.1).abs() > 0.5 =>
            {
                state.shown_at = Some(now);
            }
            Some(_) => {}
        }
        state.seen = Some(scrolled);
        if state.near.is_some() || state.held.is_some() {
            return 1.0;
        }
        state
            .shown_at
            .map_or(0.0, |at| fade(now.saturating_duration_since(at)))
    }

    /// The pointer came near a bar (`Some`) or left them (`None`); whether
    /// that changed anything.
    fn set_near(&self, near: Option<Axis>, now: Instant) -> bool {
        let mut state = self.0.borrow_mut();
        if state.near == near {
            return false;
        }
        if near.is_none() {
            state.shown_at = Some(now);
        }
        state.near = near;
        true
    }

    fn held(&self) -> Option<Held> {
        self.0.borrow().held
    }

    fn hold(&self, held: Option<Held>, now: Instant) {
        let mut state = self.0.borrow_mut();
        if held.is_none() {
            state.shown_at = Some(now);
        }
        state.held = held;
    }

    /// Whether the bar along `axis` is under the pointer or held.
    fn active(&self, axis: Axis) -> bool {
        let state = self.0.borrow();
        state.near == Some(axis) || state.held.is_some_and(|held| held.axis == axis)
    }
}

/// The bars' opacity `idle` after they last scrolled or were let go.
fn fade(idle: Duration) -> f32 {
    if idle <= SHOWN {
        1.0
    } else if idle >= SHOWN + FADE {
        0.0
    } else {
        1.0 - (idle - SHOWN).as_secs_f32() / FADE.as_secs_f32()
    }
}

/// Where a thumb goes along a view `viewport` long, for content `overflow`
/// longer than it, scrolled `scrolled` of the way, its track `corner` short
/// of the far end (where the other bar runs): its start and length.
pub(crate) fn thumb_span(
    viewport: f32,
    overflow: f32,
    scrolled: f32,
    corner: f32,
) -> Option<(f32, f32)> {
    let track = viewport - 2.0 * INSET - corner;
    if track <= 0.0 || overflow <= 0.5 {
        return None;
    }
    let length = (track * viewport / (viewport + overflow)).clamp(MIN_LENGTH.min(track), track);
    let progress = (scrolled / overflow).clamp(0.0, 1.0);
    Some((INSET + progress * (track - length), length))
}

/// How far a view is scrolled when its thumb starts at `start` (the inverse
/// of `thumb_span`), in range.
pub(crate) fn scrolled_at(viewport: f32, overflow: f32, corner: f32, start: f32) -> f32 {
    let Some((_, length)) = thumb_span(viewport, overflow, 0.0, corner) else {
        return 0.0;
    };
    let room = viewport - 2.0 * INSET - corner - length;
    if room <= 0.0 {
        return 0.0;
    }
    ((start - INSET) / room).clamp(0.0, 1.0) * overflow
}

/// Where a page from `scrolled` goes, toward the end (`forward`) or the
/// start, in a view `viewport` long scrolling `overflow`.
pub(crate) fn paged(scrolled: f32, viewport: f32, overflow: f32, forward: bool) -> f32 {
    let page = (viewport - PAGE_OVERLAP).max(viewport / 2.0);
    let to = if forward {
        scrolled + page
    } else {
        scrolled - page
    };
    to.clamp(0.0, overflow.max(0.0))
}

/// One bar this frame: which way it runs, its band in the window, where
/// along the view it starts and how long the view is that way, how far it
/// overflows and is scrolled, its track's room taken by the other bar, and
/// its thumb's start and length (from `start`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bar {
    pub(crate) axis: Axis,
    pub(crate) band: Bounds<Pixels>,
    pub(crate) start: f32,
    pub(crate) viewport: f32,
    pub(crate) overflow: f32,
    pub(crate) scrolled: f32,
    pub(crate) corner: f32,
    pub(crate) thumb: (f32, f32),
}

/// The bars a view with this geometry shows (none when nothing overflows).
pub(crate) fn bars(geometry: &Geometry) -> Vec<Bar> {
    let view = geometry.viewport;
    let (left, top) = (f32::from(view.origin.x), f32::from(view.origin.y));
    let (width, height) = (f32::from(view.size.width), f32::from(view.size.height));
    let across = geometry.overflow.0 > 0.5;
    let down = geometry.overflow.1 > 0.5;
    // When both run, each track stops short of the corner the other takes.
    let corner = if across && down { BAND } else { 0.0 };
    let band = BAND.min(width).min(height);
    let mut bars = Vec::new();
    if down {
        if let Some(thumb) = thumb_span(height, geometry.overflow.1, geometry.scrolled.1, corner) {
            bars.push(Bar {
                axis: Axis::Vertical,
                band: Bounds::new(
                    point(px(left + width - band), px(top)),
                    size(px(band), px(height - corner)),
                ),
                start: top,
                viewport: height,
                overflow: geometry.overflow.1,
                scrolled: geometry.scrolled.1,
                corner,
                thumb,
            });
        }
    }
    if across {
        if let Some(thumb) = thumb_span(width, geometry.overflow.0, geometry.scrolled.0, corner) {
            bars.push(Bar {
                axis: Axis::Horizontal,
                band: Bounds::new(
                    point(px(left), px(top + height - band)),
                    size(px(width - corner), px(band)),
                ),
                start: left,
                viewport: width,
                overflow: geometry.overflow.0,
                scrolled: geometry.scrolled.0,
                corner,
                thumb,
            });
        }
    }
    bars
}

impl Bar {
    /// The pointer's place along the bar, from the view's start.
    fn along(&self, position: Point<Pixels>) -> f32 {
        match self.axis {
            Axis::Vertical => f32::from(position.y) - self.start,
            Axis::Horizontal => f32::from(position.x) - self.start,
        }
    }

    /// What a press `along` the bar does: take the thumb (how far into it),
    /// or page toward the end (`true`) or the start.
    fn press(&self, along: f32) -> Press {
        let (start, length) = self.thumb;
        if along >= start && along <= start + length {
            Press::Grab(along - start)
        } else {
            Press::Page(along > start)
        }
    }

    /// The thumb's box in the window, `thickness` across.
    fn thumb_bounds(&self, thickness: f32) -> Bounds<Pixels> {
        let (start, length) = self.thumb;
        let band = self.band;
        match self.axis {
            Axis::Vertical => Bounds::new(
                point(
                    band.origin.x + band.size.width - px(INSET + thickness),
                    px(self.start + start),
                ),
                size(px(thickness), px(length)),
            ),
            Axis::Horizontal => Bounds::new(
                point(
                    px(self.start + start),
                    band.origin.y + band.size.height - px(INSET + thickness),
                ),
                size(px(length), px(thickness)),
            ),
        }
    }

    /// The track's box (the whole run of the thumb), `thickness` across.
    fn track_bounds(&self, thickness: f32) -> Bounds<Pixels> {
        let run = self.viewport - 2.0 * INSET - self.corner;
        let band = self.band;
        match self.axis {
            Axis::Vertical => Bounds::new(
                point(
                    band.origin.x + band.size.width - px(INSET + thickness),
                    px(self.start + INSET),
                ),
                size(px(thickness), px(run)),
            ),
            Axis::Horizontal => Bounds::new(
                point(
                    px(self.start + INSET),
                    band.origin.y + band.size.height - px(INSET + thickness),
                ),
                size(px(run), px(thickness)),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Press {
    Grab(f32),
    Page(bool),
}

/// What prepaint hands paint: the bars, how visible they are, and each
/// bar's hit area.
struct Prepainted {
    bars: Vec<(Bar, Hitbox)>,
    opacity: f32,
}

/// The bars for a view scrolled as `scrolled` says, as a zero-size child to
/// put last in the view (or beside a virtualized list).
pub(crate) fn bars_for(scrolled: Scrolled, activity: Activity) -> AnyElement {
    let source = scrolled.clone();
    let state = activity.clone();
    canvas(
        move |_, window, _cx| {
            let geometry = source.geometry();
            let now = Instant::now();
            let opacity = state.visibility(geometry.scrolled, now);
            let found = bars(&geometry);
            if found.is_empty() {
                // Nothing to scroll (any more): nothing near, nothing held.
                state.set_near(None, now);
                state.hold(None, now);
            }
            // Shown, a bar takes the pointer from the content under it (not the
            // wheel, which still scrolls the view). Hidden, it only listens.
            let behavior = if opacity > 0.0 {
                HitboxBehavior::BlockMouseExceptScroll
            } else {
                HitboxBehavior::Normal
            };
            let bars = found
                .into_iter()
                .map(|bar| {
                    let hitbox = window.insert_hitbox(bar.band, behavior);
                    (bar, hitbox)
                })
                .collect();
            Prepainted { bars, opacity }
        },
        move |_, prepainted: Prepainted, window, _cx| {
            let Prepainted { bars, opacity } = prepainted;
            if bars.is_empty() {
                return;
            }
            listen(&bars, opacity, &scrolled, &activity, window);
            if opacity <= 0.0 {
                return;
            }
            let resting = activity.0.borrow().near.is_none() && activity.held().is_none();
            if resting {
                // Shown or fading by itself: look again next frame.
                window.request_animation_frame();
            }
            for (bar, _) in &bars {
                let active = activity.active(bar.axis);
                let thickness = if active { WIDE } else { WIDTH };
                let radius = px(thickness / 2.0);
                if active {
                    let track = with_opacity(TRACK, opacity);
                    window
                        .paint_quad(fill(bar.track_bounds(thickness), track).corner_radii(radius));
                }
                let color = with_opacity(if active { COLOR_HELD } else { COLOR }, opacity);
                window.paint_quad(fill(bar.thumb_bounds(thickness), color).corner_radii(radius));
            }
        },
    )
    .absolute()
    .top(px(0.0))
    .left(px(0.0))
    .size(px(0.0))
    .into_any_element()
}

fn with_opacity(color: u32, opacity: f32) -> gpui::Rgba {
    let alpha = ((color & 0xff) as f32 * opacity).round() as u32;
    rgba((color & !0xff) | alpha)
}

/// The pointer near, over, or holding a bar, for this frame.
fn listen(
    bars: &[(Bar, Hitbox)],
    opacity: f32,
    scrolled: &Scrolled,
    activity: &Activity,
    window: &mut Window,
) {
    let hovered = |bars: &[(Bar, Hitbox)], window: &Window| {
        bars.iter()
            .find(|(_, hitbox)| hitbox.is_hovered(window))
            .map(|(bar, _)| *bar)
    };
    {
        let bars = bars.to_vec();
        let (scrolled, activity) = (scrolled.clone(), activity.clone());
        window.on_mouse_event(
            move |event: &MouseMoveEvent, phase, window, _cx: &mut App| {
                if phase != DispatchPhase::Capture {
                    return;
                }
                let now = Instant::now();
                if let Some(held) = activity.held() {
                    if let Some((bar, _)) = bars.iter().find(|(bar, _)| bar.axis == held.axis) {
                        let start = bar.along(event.position) - held.grab;
                        scrolled.scroll_to(
                            bar.axis,
                            scrolled_at(bar.viewport, bar.overflow, bar.corner, start),
                        );
                        window.refresh();
                    }
                    return;
                }
                let near = hovered(&bars, window).map(|bar| bar.axis);
                if activity.set_near(near, now) {
                    window.refresh();
                }
            },
        );
    }
    {
        let bars = bars.to_vec();
        let (scrolled, activity) = (scrolled.clone(), activity.clone());
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx: &mut App| {
            // Before the content under it hears the press: a shown bar takes it.
            if phase != DispatchPhase::Capture || event.button != MouseButton::Left {
                return;
            }
            if opacity <= 0.0 {
                return;
            }
            let Some(bar) = hovered(&bars, window) else {
                return;
            };
            let now = Instant::now();
            match bar.press(bar.along(event.position)) {
                Press::Grab(grab) => {
                    scrolled.grabbed();
                    activity.hold(
                        Some(Held {
                            axis: bar.axis,
                            grab,
                        }),
                        now,
                    );
                }
                Press::Page(forward) => {
                    let to = paged(bar.scrolled, bar.viewport, bar.overflow, forward);
                    scrolled.scroll_to(bar.axis, to);
                }
            }
            window.refresh();
            cx.stop_propagation();
        });
    }
    {
        let (scrolled, activity) = (scrolled.clone(), activity.clone());
        window.on_mouse_event(move |event: &MouseUpEvent, phase, window, _cx: &mut App| {
            if phase != DispatchPhase::Capture || event.button != MouseButton::Left {
                return;
            }
            if activity.held().is_some() {
                scrolled.let_go();
                activity.hold(None, Instant::now());
                window.refresh();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{bars, fade, paged, scrolled_at, thumb_span, Activity, Axis, Geometry, Press};
    use super::{BAND, FADE, SHOWN};
    use gpui::{point, px, size, Bounds};
    use std::time::{Duration, Instant};

    #[test]
    fn the_bar_shows_while_scrolling_then_fades() {
        let activity = Activity::default();
        let start = Instant::now();
        assert_eq!(
            activity.visibility((0.0, 0.0), start),
            0.0,
            "a view opens without its bar"
        );
        assert_eq!(
            activity.visibility((0.0, 0.0), start),
            0.0,
            "nor shows it standing still"
        );
        assert_eq!(
            activity.visibility((0.0, 120.0), start),
            1.0,
            "scrolling shows it"
        );
        assert_eq!(fade(SHOWN / 2), 1.0);
        assert!((fade(SHOWN + FADE / 2) - 0.5).abs() < 0.01);
        assert_eq!(fade(SHOWN + FADE + Duration::from_millis(1)), 0.0);
        assert_eq!(
            activity.visibility((0.0, 120.0), start + SHOWN + FADE + Duration::from_secs(1)),
            0.0,
            "then it is gone"
        );
        assert_eq!(
            activity.visibility((40.0, 120.0), start + Duration::from_secs(5)),
            1.0,
            "scrolling across shows it too"
        );
    }

    #[test]
    fn the_pointer_near_the_edge_shows_the_bar_until_it_leaves() {
        let activity = Activity::default();
        let start = Instant::now();
        assert_eq!(activity.visibility((0.0, 0.0), start), 0.0);
        assert!(activity.set_near(Some(Axis::Vertical), start));
        assert!(!activity.set_near(Some(Axis::Vertical), start), "no change");
        let later = start + Duration::from_secs(10);
        assert_eq!(
            activity.visibility((0.0, 0.0), later),
            1.0,
            "stays while near"
        );
        assert!(activity.active(Axis::Vertical));
        assert!(!activity.active(Axis::Horizontal));
        assert!(activity.set_near(None, later));
        assert_eq!(
            activity.visibility((0.0, 0.0), later + SHOWN / 2),
            1.0,
            "a moment"
        );
        assert_eq!(
            activity.visibility((0.0, 0.0), later + SHOWN + FADE + Duration::from_millis(1)),
            0.0,
            "then fades"
        );
    }

    #[test]
    fn a_thumb_shows_the_part_in_view_and_where_it_is() {
        assert_eq!(thumb_span(400.0, 0.0, 0.0, 0.0), None, "nothing to scroll");
        let (start, length) = thumb_span(400.0, 400.0, 0.0, 0.0).expect("half in view");
        assert_eq!(start, 3.0);
        assert!((length - 197.0).abs() < 0.01);
        let (end, _) = thumb_span(400.0, 400.0, 400.0, 0.0).expect("at the bottom");
        assert!((end + length - 397.0).abs() < 0.01);
        let (_, short) = thumb_span(400.0, 100_000.0, 0.0, 0.0).expect("very long");
        assert_eq!(short, 28.0, "never shorter than the minimum");
        // Past either end (a stale offset), the thumb stays on its track.
        let (past, _) = thumb_span(400.0, 400.0, 900.0, 0.0).expect("past the end");
        assert_eq!(past, end);
        // Beside the other bar, the track stops short of the corner.
        let (end, length) = thumb_span(400.0, 400.0, 400.0, BAND).expect("with a corner");
        assert!((end + length - (397.0 - BAND)).abs() < 0.01);
    }

    #[test]
    fn dragging_the_thumb_scrolls_in_step_with_it() {
        for (viewport, overflow, corner) in [(400.0, 400.0, 0.0), (300.0, 5000.0, BAND)] {
            for scrolled in [0.0, 1.0, overflow / 3.0, overflow - 1.0, overflow] {
                let (start, _) = thumb_span(viewport, overflow, scrolled, corner).unwrap();
                let back = scrolled_at(viewport, overflow, corner, start);
                assert!(
                    (back - scrolled).abs() < 0.01,
                    "{viewport}/{overflow}: {scrolled} → {start} → {back}"
                );
            }
            // Dragged past the ends, it stops at them.
            assert_eq!(scrolled_at(viewport, overflow, corner, -50.0), 0.0);
            assert_eq!(scrolled_at(viewport, overflow, corner, 10_000.0), overflow);
        }
    }

    #[test]
    fn a_press_beside_the_thumb_pages_toward_it() {
        let geometry = Geometry {
            viewport: Bounds::new(point(px(100.0), px(50.0)), size(px(300.0), px(400.0))),
            overflow: (0.0, 1200.0),
            scrolled: (0.0, 400.0),
        };
        let [bar] = bars(&geometry)[..] else {
            panic!("one bar");
        };
        assert_eq!(bar.axis, Axis::Vertical);
        // Along the right edge, the view's height.
        assert_eq!(bar.band.origin, point(px(400.0 - BAND), px(50.0)));
        assert_eq!(bar.band.size, size(px(BAND), px(400.0)));
        let (start, length) = bar.thumb;
        assert_eq!(bar.press(start + length / 2.0), Press::Grab(length / 2.0));
        assert_eq!(bar.press(start - 1.0), Press::Page(false));
        assert_eq!(bar.press(start + length + 1.0), Press::Page(true));
        // A page is the view less a line's overlap; never past the ends.
        assert_eq!(paged(400.0, 400.0, 1200.0, true), 776.0);
        assert_eq!(paged(400.0, 400.0, 1200.0, false), 24.0);
        assert_eq!(paged(1000.0, 400.0, 1200.0, true), 1200.0);
        assert_eq!(paged(100.0, 400.0, 1200.0, false), 0.0);
    }

    #[test]
    fn a_view_that_scrolls_both_ways_has_two_bars_that_leave_the_corner() {
        let geometry = Geometry {
            viewport: Bounds::new(point(px(0.0), px(0.0)), size(px(300.0), px(200.0))),
            overflow: (600.0, 800.0),
            scrolled: (0.0, 0.0),
        };
        let found = bars(&geometry);
        assert_eq!(found.len(), 2);
        let (down, across) = (found[0], found[1]);
        assert_eq!(down.axis, Axis::Vertical);
        assert_eq!(across.axis, Axis::Horizontal);
        assert_eq!(f32::from(down.band.size.height), 200.0 - BAND);
        assert_eq!(f32::from(across.band.size.width), 300.0 - BAND);
        assert_eq!(f32::from(across.band.origin.y), 200.0 - BAND);
        // Nothing overflowing: no bars.
        let still = Geometry {
            overflow: (0.0, 0.0),
            ..geometry
        };
        assert!(bars(&still).is_empty());
    }
}
