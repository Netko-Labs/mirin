//! What a field draws beside its text, apart from the caret and the
//! selection (`caret.rs`): the driver's highlights (find's matches), washed
//! behind the glyphs and under the selection whether or not the field has
//! the keyboard, and a multiline field's line numbers, in a gutter at its
//! left. Neither is part of the laid-out text, so the text lays out the same
//! with them or without, and neither is ever selected or copied.
//!
//! Both are painted only where the field shows through its clip (a long
//! document in a scroll view): the drawn lines between the clip's top and
//! bottom are found by hit-testing the layout there, so a highlight or a
//! line scrolled out of view costs nothing.

use std::ops::Range;

use gpui::{fill, point, px, rgba, App, Pixels, SharedString, TextLayout, Window};

use crate::caret::{caret_point, selection_rects, Laid};
use crate::field::Display;
use crate::tree::{parse_color, Highlight};

#[cfg(test)]
mod tests;

/// The gap between a line number's right edge and the text, in px.
pub(crate) const LINE_NUMBER_GAP: f32 = 10.0;

/// The driver's highlights as byte ranges of the drawn `display` of
/// `buffer`, with their colors, ordered by where they start. Offsets are
/// UTF-16 (JavaScript's string indices) into the buffer, clamped to it; an
/// input method's composition shown at the caret pushes what is after it
/// along. Empty ranges and colors that don't parse are left out.
pub(crate) fn highlight_ranges(
    buffer: &str,
    display: &Display,
    highlights: &[Highlight],
) -> Vec<(Range<usize>, u32)> {
    let offsets: Vec<usize> = highlights
        .iter()
        .flat_map(|highlight| [highlight.start, highlight.end])
        .collect();
    let bytes = utf16_bytes(buffer, &offsets);
    let shown = |byte: usize| match &display.composition {
        Some(composition) if byte >= composition.start => byte + composition.len(),
        _ => byte,
    };
    let mut ranges: Vec<(Range<usize>, u32)> = highlights
        .iter()
        .zip(bytes.as_chunks::<2>().0)
        .filter_map(|(highlight, &[start, end])| {
            let color = parse_color(&highlight.color)?;
            (start < end).then(|| (shown(start)..shown(end), color))
        })
        .collect();
    ranges.sort_by_key(|(range, _)| range.start);
    ranges
}

/// The byte of `text` each UTF-16 offset falls on, in one pass over the
/// text: clamped to its end, and moved back to the start of a character it
/// falls inside.
pub(crate) fn utf16_bytes(text: &str, offsets: &[usize]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..offsets.len()).collect();
    order.sort_by_key(|&index| offsets[index]);
    let mut bytes = vec![text.len(); offsets.len()];
    let mut chars = text.char_indices();
    let mut current = chars.next();
    let mut units = 0;
    for index in order {
        let wanted = offsets[index];
        while let Some((_, ch)) = current {
            if units + ch.len_utf16() > wanted {
                break;
            }
            units += ch.len_utf16();
            current = chars.next();
        }
        bytes[index] = current.map_or(text.len(), |(byte, _)| byte);
    }
    bytes
}

/// The bytes of a laid-out text drawn between window ys `top` and
/// `bottom`: from the start of the drawn line at `top` to the end of the
/// one at `bottom`. `None` when none of it is drawn there.
pub(crate) fn visible_bytes(laid: &dyn Laid, top: Pixels, bottom: Pixels) -> Option<Range<usize>> {
    let bounds = laid.bounds();
    let top = top.max(bounds.top());
    let bottom = bottom.min(bounds.bottom());
    if bottom < top {
        return None;
    }
    let start = laid.hit(point(bounds.left() - px(1.0), top));
    let end = laid.hit(point(bounds.right() + px(100_000.0), bottom));
    Some(start..end.max(start))
}

/// The lines of `text` (each from its start or a line break) that start in
/// bytes `seen`, and the one `seen` starts in: each one's first byte and
/// its number, counting from 1.
pub(crate) fn line_starts(text: &str, seen: Range<usize>) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let from = seen.start.min(bytes.len());
    let first = bytes[..from]
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map_or(0, |at| at + 1);
    let mut number = bytes[..first].iter().filter(|&&byte| byte == b'\n').count() + 1;
    let mut at = first;
    let mut starts = vec![(at, number)];
    while let Some(next) = bytes[at..].iter().position(|&byte| byte == b'\n') {
        at += next + 1;
        if at > seen.end {
            break;
        }
        number += 1;
        starts.push((at, number));
    }
    starts
}

/// Where a highlight is drawn, for one painted frame: the part of `range`
/// on the drawn lines `seen`, up to the line break after them (so a range
/// running far below the clip is walked no further). `None` when none of
/// it is there.
pub(crate) fn visible_part(
    text: &str,
    range: &Range<usize>,
    seen: &Range<usize>,
) -> Option<Range<usize>> {
    let limit = text
        .get(seen.end..)
        .and_then(|rest| rest.find('\n'))
        .map_or(text.len(), |at| seen.end + at + 1);
    let start = range.start.max(seen.start);
    let end = range.end.min(limit);
    (start < end).then_some(start..end)
}

/// Paint `ranges` (bytes of the laid-out `text`, `highlight_ranges`) behind
/// it, each in its color, where the window's clip shows them.
pub(crate) fn paint_highlights(
    layout: &TextLayout,
    text: &str,
    ranges: &[(Range<usize>, u32)],
    window: &mut Window,
) {
    let clip = window.content_mask().bounds;
    let Some(seen) = visible_bytes(layout, clip.top(), clip.bottom()) else {
        return;
    };
    let newline = layout.line_height() / 3.0;
    for (range, color) in ranges {
        if range.start > seen.end {
            break;
        }
        let Some(shown) = visible_part(text, range, &seen) else {
            continue;
        };
        for rect in selection_rects(layout, text, shown, newline) {
            window.paint_quad(fill(rect, rgba(*color)));
        }
    }
}

/// Paint each line's number in `color` at its first drawn row, its right
/// edge `LINE_NUMBER_GAP` before the text, where the window's clip shows
/// it; a field showing its placeholder has line 1 alone. In the field's own
/// font and size.
pub(crate) fn paint_line_numbers(
    layout: &TextLayout,
    text: &str,
    placeholder: bool,
    color: u32,
    window: &mut Window,
    cx: &mut App,
) {
    let bounds = layout.bounds();
    let rows: Vec<(Pixels, usize)> = if placeholder {
        vec![(bounds.top(), 1)]
    } else {
        let clip = window.content_mask().bounds;
        let Some(seen) = visible_bytes(layout, clip.top(), clip.bottom()) else {
            return;
        };
        line_starts(text, seen)
            .into_iter()
            .filter_map(|(byte, number)| Some((caret_point(layout, text, byte)?.y, number)))
            .collect()
    };
    let style = window.text_style();
    let size = style.font_size.to_pixels(window.rem_size());
    let line_height = layout.line_height();
    let right = bounds.left() - px(LINE_NUMBER_GAP);
    for (y, number) in rows {
        let label = SharedString::from(number.to_string());
        let mut run = style.to_run(label.len());
        run.color = rgba(color).into();
        let shaped = window.text_system().shape_line(label, size, &[run], None);
        let _ = shaped.paint(point(right - shaped.width, y), line_height, window, cx);
    }
}
