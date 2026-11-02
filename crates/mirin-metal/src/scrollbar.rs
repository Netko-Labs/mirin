//! Overlay scroll bars: a thin rounded thumb along a scroll view's right edge
//! while its content is taller than it, at the scroll position (GPUI draws
//! none of its own). It takes no input; the content is what scrolls. Like
//! macOS's, it hides itself: it shows while the view scrolls, stays a moment,
//! then fades out.
//!
//! The thumb is painted, not laid out: a zero-size canvas that, when it
//! paints, reads the view's ScrollHandle (already laid out this frame) and
//! paints a rounded quad over the viewport. A laid-out child would count
//! toward the content's height and, following the scroll, let it scroll
//! forever.

use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use gpui::{canvas, fill, point, px, rgba, size, AnyElement, Bounds, IntoElement, ScrollHandle, Styled};

/// How long the thumb stays after the last scroll, and how long it fades.
const SHOWN: Duration = Duration::from_millis(900);
const FADE: Duration = Duration::from_millis(300);

/// Where a view was last seen scrolled, and when that last changed.
#[derive(Clone, Default)]
pub(crate) struct Activity(Rc<Cell<(Option<f32>, Option<Instant>)>>);

impl Activity {
    /// Note the scroll position now; how visible the thumb is (0 to 1).
    fn visibility(&self, scrolled: f32, now: Instant) -> f32 {
        let (seen, changed) = self.0.get();
        let changed = match seen {
            // The first look is not a scroll: a view does not open with its bar showing.
            None => None,
            Some(seen) if (seen - scrolled).abs() > 0.5 => Some(now),
            Some(_) => changed,
        };
        self.0.set((Some(scrolled), changed));
        changed.map_or(0.0, |at| fade(now.saturating_duration_since(at)))
    }
}

/// The thumb's opacity `idle` after the last scroll.
fn fade(idle: Duration) -> f32 {
    if idle <= SHOWN {
        1.0
    } else if idle >= SHOWN + FADE {
        0.0
    } else {
        1.0 - (idle - SHOWN).as_secs_f32() / FADE.as_secs_f32()
    }
}

/// Thumb width, its gap to the edge, and the shortest a thumb gets (px).
const WIDTH: f32 = 6.0;
const INSET: f32 = 3.0;
const MIN_LENGTH: f32 = 28.0;
/// Gray at half strength: it reads on light and dark backgrounds alike.
const COLOR: u32 = 0x8080_8090;

/// Where a thumb goes along a track `viewport` long, for content `overflow`
/// longer than it, scrolled `scrolled` of the way: its start and length.
pub(crate) fn thumb_span(viewport: f32, overflow: f32, scrolled: f32) -> Option<(f32, f32)> {
    if viewport <= 2.0 * INSET || overflow <= 0.5 {
        return None;
    }
    let track = viewport - 2.0 * INSET;
    let length = (track * viewport / (viewport + overflow)).clamp(MIN_LENGTH.min(track), track);
    let progress = (scrolled / overflow).clamp(0.0, 1.0);
    Some((INSET + progress * (track - length), length))
}

/// The vertical thumb for a view scrolled by `handle` (painted only while
/// something overflows, and while it scrolls or fades).
pub(crate) fn vertical(handle: ScrollHandle, activity: Activity) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |_, (), window, _cx| {
            let viewport = handle.bounds();
            let overflow = f32::from(handle.max_offset().height);
            // The offset is negative as the content moves up.
            let scrolled = -f32::from(handle.offset().y);
            let opacity = activity.visibility(scrolled, Instant::now());
            if opacity <= 0.0 {
                return;
            }
            // Shown or fading: look again next frame.
            window.request_animation_frame();
            let Some((start, length)) = thumb_span(f32::from(viewport.size.height), overflow, scrolled) else {
                return;
            };
            let origin = point(
                viewport.origin.x + viewport.size.width - px(INSET + WIDTH),
                viewport.origin.y + px(start),
            );
            let thumb = Bounds::new(origin, size(px(WIDTH), px(length)));
            let alpha = ((COLOR & 0xff) as f32 * opacity).round() as u32;
            let color = (COLOR & !0xff) | alpha;
            window.paint_quad(fill(thumb, rgba(color)).corner_radii(px(WIDTH / 2.0)));
        },
    )
    .absolute()
    .top(px(0.0))
    .left(px(0.0))
    .size(px(0.0))
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{fade, thumb_span, Activity, FADE, SHOWN};
    use std::time::{Duration, Instant};

    #[test]
    fn the_bar_shows_while_scrolling_then_fades() {
        let activity = Activity::default();
        let start = Instant::now();
        assert_eq!(activity.visibility(0.0, start), 0.0, "a view opens without its bar");
        assert_eq!(activity.visibility(0.0, start), 0.0, "nor shows it standing still");
        assert_eq!(activity.visibility(120.0, start), 1.0, "scrolling shows it");
        assert_eq!(fade(SHOWN / 2), 1.0);
        assert!((fade(SHOWN + FADE / 2) - 0.5).abs() < 0.01);
        assert_eq!(fade(SHOWN + FADE + Duration::from_millis(1)), 0.0);
        assert_eq!(activity.visibility(120.0, start + SHOWN + FADE + Duration::from_secs(1)), 0.0, "then it is gone");
    }

    #[test]
    fn a_thumb_shows_the_part_in_view_and_where_it_is() {
        assert_eq!(thumb_span(400.0, 0.0, 0.0), None, "nothing to scroll");
        let (start, length) = thumb_span(400.0, 400.0, 0.0).expect("half in view");
        assert_eq!(start, 3.0);
        assert!((length - 197.0).abs() < 0.01);
        let (end, _) = thumb_span(400.0, 400.0, 400.0).expect("at the bottom");
        assert!((end + length - 397.0).abs() < 0.01);
        let (_, short) = thumb_span(400.0, 100_000.0, 0.0).expect("very long");
        assert_eq!(short, 28.0, "never shorter than the minimum");
    }
}
