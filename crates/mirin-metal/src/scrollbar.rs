//! Overlay scroll bars: a thin rounded thumb along a scroll view's right edge
//! while its content is taller than it, at the scroll position (GPUI draws
//! none of its own). It takes no input; the content is what scrolls.
//!
//! The thumb is painted, not laid out: a zero-size canvas that, when it
//! paints, reads the view's ScrollHandle (already laid out this frame) and
//! paints a rounded quad over the viewport. A laid-out child would count
//! toward the content's height and, following the scroll, let it scroll
//! forever.

use gpui::{canvas, fill, point, px, rgba, size, AnyElement, Bounds, IntoElement, ScrollHandle, Styled};

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

/// The vertical thumb for a view scrolled by `handle` (painted only while something overflows).
pub(crate) fn vertical(handle: &ScrollHandle) -> AnyElement {
    let handle = handle.clone();
    canvas(
        |_, _, _| (),
        move |_, (), window, _cx| {
            let viewport = handle.bounds();
            let overflow = f32::from(handle.max_offset().height);
            // The offset is negative as the content moves up.
            let scrolled = -f32::from(handle.offset().y);
            let Some((start, length)) = thumb_span(f32::from(viewport.size.height), overflow, scrolled) else {
                return;
            };
            let origin = point(
                viewport.origin.x + viewport.size.width - px(INSET + WIDTH),
                viewport.origin.y + px(start),
            );
            let thumb = Bounds::new(origin, size(px(WIDTH), px(length)));
            window.paint_quad(fill(thumb, rgba(COLOR)).corner_radii(px(WIDTH / 2.0)));
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
    use super::thumb_span;

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
