//! The input method's view of a field: one document, the text with the
//! composition in it at the caret, in UTF-16 offsets (GPUI's
//! `InputHandler`), and what the input method does to it.

use std::ops::Range;

use super::{char_to_byte, utf16_len, utf16_to_byte, Field};

impl Field {
    pub(super) fn cursor_byte(&self) -> usize {
        char_to_byte(&self.buffer, self.cursor.min(self.len()))
    }

    fn cursor_utf16(&self) -> usize {
        utf16_len(&self.buffer[..self.cursor_byte()])
    }

    fn preedit_utf16(&self) -> usize {
        self.preedit.as_deref().map_or(0, utf16_len)
    }

    /// The document: the text with the composition at the caret.
    pub(super) fn document(&self) -> String {
        let mut text = self.buffer.clone();
        if let Some(preedit) = &self.preedit {
            text.insert_str(self.cursor_byte(), preedit);
        }
        text
    }

    /// The selection, else the caret (after the composition, where it is
    /// drawn; a composition replaced the selection when it began).
    pub(crate) fn selected_utf16(&self) -> Range<usize> {
        if self.preedit.is_none() && self.has_selection() {
            let (start, end) = self.selection_utf16();
            return start..end;
        }
        let caret = self.cursor_utf16() + self.preedit_utf16();
        caret..caret
    }

    /// The composition's range in the document, while there is one.
    pub(crate) fn marked_utf16(&self) -> Option<Range<usize>> {
        let start = self.cursor_utf16();
        self.preedit
            .as_ref()
            .map(|preedit| start..start + utf16_len(preedit))
    }

    pub(crate) fn text_for_utf16(&self, range: Range<usize>) -> String {
        let document = self.document();
        let start = utf16_to_byte(&document, range.start);
        let end = utf16_to_byte(&document, range.end.max(range.start));
        document[start..end].to_owned()
    }

    /// The input method composes `text` at the caret (empty: it took the
    /// composition back). A composition begun over a selection replaces it,
    /// as typing would. Says whether the text itself changed.
    pub(crate) fn compose(&mut self, text: &str) -> bool {
        let text = clean(text, false);
        if text.is_empty() {
            self.preedit = None;
            return false;
        }
        let cleared = self.delete_selection();
        self.preedit = Some(text);
        cleared
    }

    /// The input method commits `text` in place of the composition (or of
    /// the selection): it is inserted at the caret. Says whether the text
    /// changed.
    pub(crate) fn commit(&mut self, text: &str, multiline: bool) -> bool {
        self.preedit = None;
        let cleared = self.delete_selection();
        self.cursor = self.cursor.min(self.len());
        let text = clean(text, multiline);
        self.insert_str(&text);
        cleared || !text.is_empty()
    }

    /// `replace_text_in_range`: with no range, or the composition's, a
    /// commit; any other range of the document is replaced by `text`, the
    /// caret after it. Says whether the text changed.
    pub(crate) fn replace_utf16(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        multiline: bool,
    ) -> bool {
        let marked = self.marked_utf16();
        let Some(range) = range.filter(|range| Some(range) != marked.as_ref()) else {
            return self.commit(text, multiline);
        };
        let start = self.buffer_char(range.start);
        let end = self.buffer_char(range.end).max(start);
        self.preedit = None;
        self.anchor = None;
        let from = char_to_byte(&self.buffer, start);
        let to = char_to_byte(&self.buffer, end);
        let text = clean(text, multiline);
        let changed = from != to || !text.is_empty();
        self.buffer.replace_range(from..to, &text);
        self.cursor = start + text.chars().count();
        changed
    }

    /// The composition becomes text, as it shows (GPUI's `unmark_text`: a
    /// click while composing). Says whether the text changed.
    pub(crate) fn unmark(&mut self, multiline: bool) -> bool {
        match self.preedit.take() {
            Some(preedit) => self.commit(&preedit, multiline),
            None => false,
        }
    }

    /// The char index in `buffer` a document offset falls on; inside the
    /// composition is the caret.
    fn buffer_char(&self, offset_utf16: usize) -> usize {
        let cursor = self.cursor_utf16();
        let offset = if offset_utf16 <= cursor {
            offset_utf16
        } else {
            cursor.max(offset_utf16.saturating_sub(self.preedit_utf16()))
        };
        let byte = utf16_to_byte(&self.buffer, offset);
        self.buffer[..byte].chars().count()
    }
}

/// Text an input method gives, as a field takes it: no control characters,
/// and a line break only in a multiline field (a space elsewhere, as paste).
fn clean(text: &str, multiline: bool) -> String {
    text.chars()
        .filter_map(|ch| match ch {
            '\n' if multiline => Some('\n'),
            '\n' => Some(' '),
            ch if ch.is_control() => None,
            ch => Some(ch),
        })
        .collect()
}
