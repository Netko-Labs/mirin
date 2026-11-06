//! The editing model of an `input` node, apart from GPUI's views: its text,
//! caret, select-all, and an input method's composition (`preedit`), with
//! what keys and an input method (`ime.rs`) do to them and what is drawn.
//!
//! The composition is not part of the text: it shows at the caret,
//! underlined, until the input method commits it (the committed text is
//! inserted then) or takes it back, so a `change` event never carries it.
//! An input method addresses the field as one document, the text with the
//! composition in it at the caret, in UTF-16 offsets (GPUI's `InputHandler`);
//! `document.rs` translates. What keys do is `keys.rs`.

mod document;
mod keys;
#[cfg(test)]
mod tests;

use std::ops::Range;

/// Caret glyph drawn at the cursor while the input has focus.
pub(crate) const CARET: &str = "\u{258F}";
/// What a secure field draws for each character.
const BULLET: char = '\u{2022}';

/// A field's text, caret, and composition.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Field {
    pub(crate) buffer: String,
    /// Caret position as a char index into `buffer`.
    pub(crate) cursor: usize,
    /// Ctrl/Cmd+A: the next insertion or deletion replaces the whole buffer.
    pub(crate) select_all: bool,
    /// An input method's text being composed at the caret; never empty.
    pub(crate) preedit: Option<String>,
}

/// What one keystroke did to a field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edit {
    None,
    Changed,
    Submitted,
    /// A navigation key the driver may act on (`onKey`).
    Key(&'static str),
    FocusNext,
    FocusPrevious,
}

/// What a field draws: its text with the caret, which part is the
/// composition (byte range, underlined), and where the caret glyph is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Display {
    pub(crate) text: String,
    pub(crate) composition: Option<Range<usize>>,
    /// Byte index of the caret glyph in `text`, when focused.
    pub(crate) caret: Option<usize>,
}

impl Field {
    /// A field holding `value`, the caret at its end.
    pub(crate) fn new(value: &str) -> Self {
        Self {
            buffer: value.to_owned(),
            cursor: value.chars().count(),
            select_all: false,
            preedit: None,
        }
    }

    /// The driver's value replaces the text; the caret goes to its end. A
    /// composition stays: the input method is still composing it.
    pub(crate) fn reset(&mut self, value: &str) {
        self.buffer = value.to_owned();
        self.cursor = value.chars().count();
    }

    fn len(&self) -> usize {
        self.buffer.chars().count()
    }

    fn insert_str(&mut self, text: &str) {
        let byte_index = char_to_byte(&self.buffer, self.cursor);
        self.buffer.insert_str(byte_index, text);
        self.cursor += text.chars().count();
    }

    fn remove_char(&mut self, char_index: usize) {
        let start = char_to_byte(&self.buffer, char_index);
        let end = char_to_byte(&self.buffer, char_index + 1);
        self.buffer.replace_range(start..end, "");
    }

    /// The text drawn: bullets for a secure field, the caret while focused,
    /// and the composition at the caret (focused and not secure only).
    pub(crate) fn display(&self, focused: bool, secure: bool) -> Display {
        let preedit = self.preedit.as_deref().filter(|_| focused && !secure);
        let mut text =
            String::with_capacity(self.buffer.len() + CARET.len() + preedit.map_or(0, str::len));
        let mut composition = None;
        let mut caret = None;
        let mut at_cursor = |text: &mut String| {
            if let Some(preedit) = preedit {
                let start = text.len();
                text.push_str(preedit);
                composition = Some(start..text.len());
            }
            caret = Some(text.len());
            text.push_str(CARET);
        };
        let len = self.len();
        let cursor = self.cursor.min(len);
        for (index, ch) in self.buffer.chars().enumerate() {
            if focused && index == cursor {
                at_cursor(&mut text);
            }
            text.push(if secure { BULLET } else { ch });
        }
        if focused && cursor >= len {
            at_cursor(&mut text);
        }
        Display {
            text,
            composition,
            caret,
        }
    }

    /// Where a document offset is in `display(true, false)`'s text, as a
    /// byte index: the caret glyph sits between the composition and the
    /// rest, so offsets after it move past the glyph.
    pub(crate) fn display_byte(&self, offset_utf16: usize) -> usize {
        let document = self.document();
        let byte = utf16_to_byte(&document, offset_utf16);
        let caret = self.cursor_byte() + self.preedit.as_deref().map_or(0, str::len);
        if byte > caret {
            byte + CARET.len()
        } else {
            byte
        }
    }
}

fn char_to_byte(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte, _)| byte)
        .unwrap_or(text.len())
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte index of a UTF-16 offset, clamped to the text and moved back to
/// the start of a character it falls inside.
fn utf16_to_byte(text: &str, offset_utf16: usize) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units + ch.len_utf16() > offset_utf16 {
            return byte;
        }
        units += ch.len_utf16();
    }
    text.len()
}
