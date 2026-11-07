//! Where a field's characters are on screen: the text as the last frame
//! laid it out, what char a point is on (a click, a drag), its drawn lines
//! (↑ and ↓, Home and End across soft-wrapped lines), and where the caret
//! and the selection are drawn over it.
//!
//! The caret and the selection are never part of the laid-out text: the
//! caret is a thin bar at a glyph boundary and the selection a wash behind
//! the glyphs, so the text never moves when either does. At a soft wrap the
//! caret is at the start of the next line, where the char after it is.
//!
//! A frame's layout is kept once it has been painted (a `TextLayout` can
//! only be asked after its prepaint), with the field it drew; keys use it
//! only while the field is still the one drawn.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{fill, point, px, size, Bounds, Hsla, Pixels, Point, TextLayout, Window};

#[cfg(test)]
mod tests;

/// Where a laid-out text's bytes are on screen: GPUI's `TextLayout` (after
/// its prepaint), or a stand-in in tests.
pub(crate) trait Laid {
    /// The top left of byte `index`'s place, in window pixels. At a soft
    /// wrap, GPUI answers the end of the line above.
    fn position(&self, index: usize) -> Option<Point<Pixels>>;
    /// The byte a point is on or nearest, inside the text or not.
    fn hit(&self, position: Point<Pixels>) -> usize;
    fn line_height(&self) -> Pixels;
    /// The height of the line byte `index` is on (paragraphs can be sized:
    /// `runs.rs`); every line's is `line_height` by default.
    fn line_height_at(&self, _index: usize) -> Pixels {
        self.line_height()
    }
    fn bounds(&self) -> Bounds<Pixels>;
}

impl Laid for TextLayout {
    fn position(&self, index: usize) -> Option<Point<Pixels>> {
        self.position_for_index(index)
    }

    fn hit(&self, position: Point<Pixels>) -> usize {
        match self.index_for_position(position) {
            Ok(byte) | Err(byte) => byte,
        }
    }

    fn line_height(&self) -> Pixels {
        TextLayout::line_height(self)
    }

    fn line_height_at(&self, index: usize) -> Pixels {
        self.line_height_for_index(index)
    }

    fn bounds(&self) -> Bounds<Pixels> {
        TextLayout::bounds(self)
    }
}

/// Where the caret before byte `index` of `text` is drawn: its top left. At
/// a soft wrap that is the start of the next line, beside the char after it.
pub(crate) fn caret_point(laid: &dyn Laid, text: &str, index: usize) -> Option<Point<Pixels>> {
    let at = laid.position(index)?;
    let next = text
        .get(index..)
        .and_then(|rest| rest.chars().next())
        .filter(|&ch| ch != '\n');
    if let Some(ch) = next {
        if let Some(after) = laid.position(index + ch.len_utf8()) {
            if after.y > at.y {
                return Some(point(laid.bounds().left(), after.y));
            }
        }
    }
    Some(at)
}

/// The caret before byte `index`: a bar `width` wide and a line tall, its
/// left edge on the glyph boundary.
pub(crate) fn caret_bar(
    laid: &dyn Laid,
    text: &str,
    index: usize,
    width: Pixels,
) -> Option<Bounds<Pixels>> {
    let at = caret_point(laid, text, index)?;
    Some(Bounds::new(at, size(width, laid.line_height_at(index))))
}

/// The drawn caret's width, before it is rounded to whole device pixels.
const CARET_WIDTH: f32 = 1.5;

/// Paint the caret before byte `index` of a laid-out text, in the ink the
/// text is drawn in, on whole device pixels so it stays crisp.
pub(crate) fn paint_caret(layout: &TextLayout, text: &str, index: usize, window: &mut Window) {
    let scale = window.scale_factor();
    let width = px((CARET_WIDTH * scale).round().max(1.0) / scale);
    let Some(mut bar) = caret_bar(layout, text, index, width) else {
        return;
    };
    bar.origin.x = px((f32::from(bar.origin.x) * scale).round() / scale);
    let ink = window.text_style().color;
    window.paint_quad(fill(bar, ink));
}

/// Paint the wash behind the selected bytes `range` of a laid-out text.
pub(crate) fn paint_selection(
    layout: &TextLayout,
    text: &str,
    range: Range<usize>,
    color: Hsla,
    window: &mut Window,
) {
    let newline = layout.line_height_at(range.start) / 3.0;
    for rect in selection_rects(layout, text, range, newline) {
        window.paint_quad(fill(rect, color));
    }
}

/// The wash behind the selected bytes `range` of `text`: one rect per drawn
/// line it covers, a line tall, from where it starts on that line to where
/// it ends. A line break it takes in shows `newline` wide past the line's end.
pub(crate) fn selection_rects(
    laid: &dyn Laid,
    text: &str,
    range: Range<usize>,
    newline: Pixels,
) -> Vec<Bounds<Pixels>> {
    let mut rects = Vec::new();
    let far = laid.bounds().right() + px(100_000.0);
    let end = range.end.min(text.len());
    let mut from = range.start;
    while from < end {
        let Some(start) = caret_point(laid, text, from) else {
            break;
        };
        let line_height = laid.line_height_at(from);
        let line_end = laid
            .hit(point(far, start.y + line_height / 2.0))
            .clamp(from, text.len());
        let (to, past, next) = if end <= line_end {
            (end, px(0.0), end)
        } else if text[line_end..].starts_with('\n') {
            (line_end, newline, line_end + 1)
        } else {
            // A soft wrap: the rest is on the next line.
            (line_end, px(0.0), line_end)
        };
        let right = laid.position(to).map_or(start.x, |at| at.x) + past;
        if right > start.x {
            rects.push(Bounds::new(start, size(right - start.x, line_height)));
        }
        if next <= from {
            break;
        }
        from = next;
    }
    rects
}

use crate::field::{Display, Field, Lines, Vertical};

/// A field as the last painted frame drew it.
pub(crate) struct Drawn {
    pub(crate) field: Field,
    pub(crate) display: Display,
    pub(crate) layout: TextLayout,
    /// The placeholder was drawn, not the text.
    pub(crate) placeholder: bool,
}

/// The last painted frame's `Drawn`, per field.
pub(crate) type DrawnCell = Rc<RefCell<Option<Drawn>>>;

impl Drawn {
    /// The byte of the drawn text where buffer char `index` is: the caret's
    /// own place at the cursor.
    fn byte_at(&self, index: usize) -> usize {
        match self.display.caret {
            Some(caret) if index == self.field.cursor.min(self.field.buffer.chars().count()) => {
                caret
            }
            _ => self.display.byte_of(index),
        }
    }

    /// The buffer char (of the field as drawn) nearest window point
    /// `position`: a point past a character's middle is after it.
    pub(crate) fn char_at(&self, position: Point<Pixels>) -> usize {
        if self.placeholder {
            return 0;
        }
        let text = &self.display.text;
        let byte = match self.layout.index_for_position(position) {
            Ok(byte) => {
                let next = text[byte.min(text.len())..]
                    .chars()
                    .next()
                    .map(|ch| byte + ch.len_utf8());
                let starts = self.layout.position_for_index(byte);
                let ends = next.and_then(|next| self.layout.position_for_index(next));
                match (starts, ends, next) {
                    (Some(start), Some(end), Some(next))
                        if start.y == end.y && position.x > (start.x + end.x) / 2.0 =>
                    {
                        next
                    }
                    _ => byte,
                }
            }
            Err(byte) => byte,
        };
        self.display.buffer_char(byte)
    }
}

impl Drawn {
    /// The buffer char drawn under window point `position`; `None` off the
    /// text (past a line's end, a placeholder).
    pub(crate) fn char_under(&self, position: Point<Pixels>) -> Option<usize> {
        if self.placeholder {
            return None;
        }
        let byte = self.layout.index_for_position(position).ok()?;
        (byte < self.display.text.len()).then(|| self.display.buffer_char(byte))
    }

    /// Where the caret before buffer char `index` would be drawn.
    fn caret_at(&self, index: usize) -> Option<Point<Pixels>> {
        caret_point(&self.layout, &self.display.text, self.byte_at(index))
    }
}

impl Lines for Drawn {
    fn line(&self, index: usize) -> Option<Range<usize>> {
        if self.placeholder {
            return None;
        }
        let at = self.caret_at(index)?;
        let bounds = self.layout.bounds();
        let y = at.y + self.layout.line_height_at(self.byte_at(index)) / 2.0;
        let start = self.layout.hit(point(bounds.left() - px(1.0), y));
        let end = self.layout.hit(point(bounds.right() + px(10_000.0), y));
        let (start, mut end) = (
            self.display.buffer_char(start),
            self.display.buffer_char(end),
        );
        // A line that wraps ends where the next begins: stop before the
        // space it wrapped at, so the caret stays on this line.
        let text = &self.display.text;
        let wraps = text[self.display.byte_of(end).min(text.len())..]
            .chars()
            .next()
            .is_some_and(|ch| ch != '\n');
        if wraps && end > start {
            let before = self.field.buffer.chars().nth(end - 1);
            if before.is_some_and(char::is_whitespace) {
                end -= 1;
            }
        }
        Some(start..end)
    }

    fn x_of(&self, index: usize) -> Option<f32> {
        if self.placeholder {
            return None;
        }
        let at = self.caret_at(index)?;
        Some(f32::from(at.x))
    }

    fn vertical(&self, index: usize, step: isize, x: f32) -> Option<Vertical> {
        if self.placeholder {
            return None;
        }
        let at = self.caret_at(index)?;
        let bounds = self.layout.bounds();
        let line = self.layout.line_height_at(self.byte_at(index));
        // Lines can differ in height (sized paragraphs): up is just above
        // this line's top, down just below its bottom, one line at a time.
        let y = if step < 0 {
            at.y - px(1.0) + line * (step + 1) as f32
        } else {
            at.y + line * step as f32 + px(1.0)
        };
        if y < bounds.top() || y > bounds.bottom() {
            return Some(Vertical::Past);
        }
        Some(Vertical::To(self.char_at(point(px(x), y))))
    }
}
