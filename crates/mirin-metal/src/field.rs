//! The editing model of an `input` node, apart from GPUI's views: its text,
//! caret, selection, and an input method's composition (`preedit`), with
//! what keys, the pointer, and an input method (`ime.rs`) do to them and
//! what is drawn.
//!
//! The selection runs from `anchor` (where it began) to `cursor` (its
//! moving end, where the caret is drawn); with no anchor, or the anchor at
//! the cursor, nothing is selected. Typing, a paste, or a composition
//! replaces what is selected.
//!
//! The composition is not part of the text: it shows at the caret,
//! underlined, until the input method commits it (the committed text is
//! inserted then) or takes it back, so a `change` event never carries it.
//! An input method addresses the field as one document, the text with the
//! composition in it at the caret, in UTF-16 offsets (GPUI's `InputHandler`);
//! `document.rs` translates. What keys do is `keys.rs`; what a press and a
//! drag do is `press.rs`; words and paragraphs are `words.rs`.

mod document;
mod keys;
mod press;
#[cfg(test)]
mod tests;
mod words;

use std::ops::Range;

pub(crate) use keys::{Clipboard, KeyEnv, Lines, Vertical};
pub(crate) use press::Press;

/// What a secure field draws for each character.
const BULLET: char = '\u{2022}';

/// A field's text, caret, selection, and composition.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Field {
    pub(crate) buffer: String,
    /// Caret position as a char index into `buffer`: the selection's moving end.
    pub(crate) cursor: usize,
    /// Where the selection began (a char index); the selection is between it
    /// and the cursor. `None`, or equal to the cursor: nothing is selected.
    pub(crate) anchor: Option<usize>,
    /// An input method's text being composed at the caret; never empty.
    pub(crate) preedit: Option<String>,
    /// The x a run of ↑/↓ keeps to, and the caret it was kept for: a caret
    /// moved any other way starts a new run.
    goal: Option<(f32, usize)>,
}

/// What one keystroke did to a field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edit {
    None,
    /// The text changed (and maybe the selection).
    Changed,
    /// Only the caret or the selection moved.
    Moved,
    /// The key was taken but changed nothing here (Copy).
    Handled,
    Submitted,
    /// A navigation key the driver may act on (`onKey`).
    Key(&'static str),
    FocusNext,
    FocusPrevious,
}

/// What a field draws: its text (with any composition at the cursor), which
/// part is the composition (byte range, underlined), which part is
/// selected, and where the caret is. The caret and the selection are drawn
/// over the laid-out text (`caret.rs`), never in it: the text lays out the
/// same wherever the caret is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Display {
    pub(crate) text: String,
    pub(crate) composition: Option<Range<usize>>,
    /// The byte of `text` the caret is drawn before, when focused: the
    /// cursor, past the composition.
    pub(crate) caret: Option<usize>,
    /// The selected text's bytes in `text`, when focused and something is selected.
    pub(crate) selection: Option<Range<usize>>,
    /// What `text` has that the buffer does not (the composition, at the
    /// cursor), as a char range of `text`.
    inserted: Range<usize>,
}

impl Display {
    /// Text drawn as it is: no caret, composition, or selection (a placeholder).
    pub(crate) fn plain(text: String) -> Self {
        Self {
            text,
            ..Self::default()
        }
    }

    /// The buffer's char index at byte `byte` of `text`: what is inserted
    /// at the cursor (the composition) is the cursor.
    pub(crate) fn buffer_char(&self, byte: usize) -> usize {
        let byte = floor_char(&self.text, byte.min(self.text.len()));
        let chars = self.text[..byte].chars().count();
        if chars <= self.inserted.start {
            chars
        } else if chars < self.inserted.end {
            self.inserted.start
        } else {
            chars - self.inserted.len()
        }
    }

    /// The byte of `text` where buffer char `index` is drawn; at the cursor
    /// that is past the composition (`caret` is the caret's own place).
    pub(crate) fn byte_of(&self, index: usize) -> usize {
        let chars = if index < self.inserted.start {
            index
        } else {
            index + self.inserted.len()
        };
        char_to_byte(&self.text, chars)
    }
}

impl Field {
    /// A field holding `value`, the caret at its end.
    pub(crate) fn new(value: &str) -> Self {
        Self {
            buffer: value.to_owned(),
            cursor: value.chars().count(),
            ..Self::default()
        }
    }

    /// The driver's value replaces the text; the caret goes to its end and
    /// nothing is selected. A composition stays: the input method is still
    /// composing it.
    pub(crate) fn reset(&mut self, value: &str) {
        self.buffer = value.to_owned();
        self.cursor = value.chars().count();
        self.anchor = None;
    }

    /// Whether this field, drawn, lays out as `other` would: the same text,
    /// any composition in the same place, and the caret at the same char.
    pub(crate) fn lays_out_as(&self, other: &Field) -> bool {
        self.cursor == other.cursor && self.preedit == other.preedit && self.buffer == other.buffer
    }

    fn len(&self) -> usize {
        self.buffer.chars().count()
    }

    /// The selection as an ordered char range (empty at the caret when
    /// nothing is selected).
    pub(crate) fn selection(&self) -> Range<usize> {
        let len = self.len();
        let cursor = self.cursor.min(len);
        match self.anchor.map(|anchor| anchor.min(len)) {
            Some(anchor) if anchor < cursor => anchor..cursor,
            Some(anchor) => cursor..anchor,
            None => cursor..cursor,
        }
    }

    pub(crate) fn has_selection(&self) -> bool {
        !self.selection().is_empty()
    }

    /// Whether the selection's moving end is its start (it was extended backwards).
    pub(crate) fn is_reversed(&self) -> bool {
        self.anchor.is_some_and(|anchor| anchor > self.cursor)
    }

    /// The selected text.
    pub(crate) fn selected_text(&self) -> &str {
        let range = self.selection();
        let start = char_to_byte(&self.buffer, range.start);
        let end = char_to_byte(&self.buffer, range.end);
        &self.buffer[start..end]
    }

    /// Select from `anchor` to `head` (char indices, clamped); the caret goes to `head`.
    pub(crate) fn select(&mut self, anchor: usize, head: usize) {
        let len = self.len();
        self.cursor = head.min(len);
        let anchor = anchor.min(len);
        self.anchor = (anchor != self.cursor).then_some(anchor);
    }

    /// Put the caret at `index` with nothing selected.
    pub(crate) fn place(&mut self, index: usize) {
        self.cursor = index.min(self.len());
        self.anchor = None;
    }

    /// Move the caret to `index`; with `extend`, the selection follows it
    /// from where it began (or from the caret).
    fn move_to(&mut self, index: usize, extend: bool) {
        if extend {
            let anchor = self.anchor.unwrap_or(self.cursor);
            self.select(anchor, index);
        } else {
            self.place(index);
        }
    }

    pub(crate) fn select_all(&mut self) {
        self.select(0, self.len());
    }

    /// Remove what is selected; the caret goes where it was. Says whether
    /// there was anything.
    pub(crate) fn delete_selection(&mut self) -> bool {
        let range = self.selection();
        if range.is_empty() {
            self.anchor = None;
            return false;
        }
        self.remove(range);
        true
    }

    /// Put `text` in place of the selection (at the caret when there is none).
    fn insert_str(&mut self, text: &str) {
        self.delete_selection();
        self.cursor = self.cursor.min(self.len());
        let byte_index = char_to_byte(&self.buffer, self.cursor);
        self.buffer.insert_str(byte_index, text);
        self.cursor += text.chars().count();
    }

    /// Remove the chars in `range`; the caret goes to its start, and nothing is selected.
    fn remove(&mut self, range: Range<usize>) {
        let start = char_to_byte(&self.buffer, range.start);
        let end = char_to_byte(&self.buffer, range.end);
        self.buffer.replace_range(start..end, "");
        self.cursor = range.start;
        self.anchor = None;
    }

    /// The selection in UTF-16 offsets into the text (JavaScript's string
    /// indices), ordered: what the driver hears and sets.
    pub(crate) fn selection_utf16(&self) -> (usize, usize) {
        let range = self.selection();
        let start = utf16_len(&self.buffer[..char_to_byte(&self.buffer, range.start)]);
        (start, start + utf16_len(self.selected_text()))
    }

    /// The driver's selection, in UTF-16 offsets into the text (clamped; an
    /// offset inside a character is its start). The caret goes to `end`.
    pub(crate) fn set_selection_utf16(&mut self, start: usize, end: usize) {
        let char_at = |offset: usize| {
            let byte = utf16_to_byte(&self.buffer, offset);
            self.buffer[..byte].chars().count()
        };
        let (anchor, head) = (char_at(start), char_at(end));
        self.select(anchor, head);
    }

    /// The text drawn: bullets for a secure field, and the composition at
    /// the caret (focused and not secure only); where the caret is and what
    /// is selected (focused only; a secure field's selection covers its
    /// bullets). Neither the caret nor the selection is part of the text.
    pub(crate) fn display(&self, focused: bool, secure: bool) -> Display {
        let preedit = self.preedit.as_deref().filter(|_| focused && !secure);
        let mut text = String::with_capacity(self.buffer.len() + preedit.map_or(0, str::len));
        let mut composition = None;
        let mut caret = None;
        let mut inserted = 0..0;
        let mut at_cursor = |text: &mut String, chars: usize| {
            let start = text.len();
            if let Some(preedit) = preedit {
                text.push_str(preedit);
                composition = Some(start..text.len());
            }
            caret = Some(text.len());
            inserted = chars..chars + text[start..].chars().count();
            inserted.end
        };
        let len = self.len();
        let cursor = self.cursor.min(len);
        let selected = self.selection();
        let mut selection = None::<Range<usize>>;
        let mut chars = 0;
        for (index, ch) in self.buffer.chars().enumerate() {
            if focused && index == cursor {
                chars = at_cursor(&mut text, chars);
            }
            if focused && index == selected.start {
                selection = Some(text.len()..text.len());
            }
            text.push(if secure { BULLET } else { ch });
            chars += 1;
            if index + 1 == selected.end {
                if let Some(range) = selection.as_mut() {
                    range.end = text.len();
                }
            }
        }
        if focused && cursor >= len {
            at_cursor(&mut text, chars);
        }
        Display {
            text,
            composition,
            caret,
            selection: selection.filter(|range| !range.is_empty()),
            inserted,
        }
    }

    /// Where a document offset is in `display(true, false)`'s text, as a
    /// byte index: the drawn text is the document.
    pub(crate) fn display_byte(&self, offset_utf16: usize) -> usize {
        utf16_to_byte(&self.document(), offset_utf16)
    }
}

fn char_to_byte(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte, _)| byte)
        .unwrap_or(text.len())
}

/// `byte`, moved back to the start of a character it falls inside.
fn floor_char(text: &str, mut byte: usize) -> usize {
    while byte > 0 && !text.is_char_boundary(byte) {
        byte -= 1;
    }
    byte
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
