//! Where a field's characters are on screen: the text as the last frame
//! laid it out, what char a point is on (a click, a drag), and its drawn
//! lines (↑ and ↓, Home and End across soft-wrapped lines).
//!
//! A frame's layout is kept once it has been painted (a `TextLayout` can
//! only be asked after its prepaint), with the field it drew; keys use it
//! only while the field is still the one drawn.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{point, px, Pixels, Point, TextLayout};

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

impl Lines for Drawn {
    fn line(&self, index: usize) -> Option<Range<usize>> {
        if self.placeholder {
            return None;
        }
        let at = self.layout.position_for_index(self.byte_at(index))?;
        let bounds = self.layout.bounds();
        let y = at.y + self.layout.line_height() / 2.0;
        let start = hit(&self.layout, point(bounds.left() - px(1.0), y));
        let end = hit(&self.layout, point(bounds.right() + px(10_000.0), y));
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
        let at = self.layout.position_for_index(self.byte_at(index))?;
        Some(f32::from(at.x))
    }

    fn vertical(&self, index: usize, step: isize, x: f32) -> Option<Vertical> {
        if self.placeholder {
            return None;
        }
        let at = self.layout.position_for_index(self.byte_at(index))?;
        let bounds = self.layout.bounds();
        let line = self.layout.line_height();
        let y = at.y + line * step as f32 + line / 2.0;
        if y < bounds.top() || y > bounds.bottom() {
            return Some(Vertical::Past);
        }
        Some(Vertical::To(self.char_at(point(px(x), y))))
    }
}

/// The byte a point is on or nearest, inside the text or not.
fn hit(layout: &TextLayout, position: Point<Pixels>) -> usize {
    match layout.index_for_position(position) {
        Ok(byte) | Err(byte) => byte,
    }
}
