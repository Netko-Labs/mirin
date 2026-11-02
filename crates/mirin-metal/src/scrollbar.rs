//! Overlay scroll bars: a thin rounded thumb along a scroll view's right edge
//! while its content is taller than it, at the scroll position (GPUI draws
//! none of its own). It sits over the content and takes no input; the content
//! is what scrolls. Placed from the view's ScrollHandle, as of the last paint.

use gpui::{div, px, rgba, Div, ParentElement, Pixels, ScrollHandle, Styled};

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

/// The vertical thumb for a view scrolled by `handle`, or None when nothing overflows.
pub(crate) fn vertical(handle: &ScrollHandle) -> Option<Div> {
    let viewport = f32::from(handle.bounds().size.height);
    let overflow = f32::from(handle.max_offset().height);
    // The offset is negative as the content moves up.
    let scrolled = -f32::from(handle.offset().y);
    let (start, length) = thumb_span(viewport, overflow, scrolled)?;
    // An absolute child scrolls with the content: put it back by the scroll.
    let top: Pixels = px(scrolled + start);
    Some(
        div()
            .absolute()
            .top(top)
            .right(px(INSET))
            .w(px(WIDTH))
            .h(px(length))
            .rounded(px(WIDTH / 2.0))
            .bg(rgba(COLOR))
            .child(div()),
    )
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
