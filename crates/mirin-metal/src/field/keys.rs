//! What a keystroke does to a field.
//!
//! The keys are the ones a field sees on Linux, after a compositor's own
//! translation (Dashi turns ❖← into Home, ❖↑ into Ctrl+Home, ⌥← into
//! Ctrl+←, and ❖⌫ into ⇧Home then Backspace): ← → by character, with
//! Ctrl or Alt by word; Home and End to the line's ends, with Ctrl to the
//! text's; ↑ ↓ by line in a multiline field. Shift with any of them
//! extends the selection. Ctrl/Cmd with A, C, X, and V: Select All, Copy,
//! Cut, Paste.

use std::ops::Range;

use gpui::Keystroke;

use super::words::{paragraph_at, word_end_after, word_start_before};
use super::{Edit, Field};

/// The system clipboard, as a field reads and writes it.
pub(crate) trait Clipboard {
    fn read(&mut self) -> Option<String>;
    fn write(&mut self, text: &str);
}

/// Where a ↑ or ↓ lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Vertical {
    /// On the line above or below, at this char.
    To(usize),
    /// There is no line that way.
    Past,
}

/// A field's lines as drawn (soft-wrapped), in buffer char indices. A field
/// that has not been drawn has none: its lines are its paragraphs then.
pub(crate) trait Lines {
    /// The drawn line holding char `index`: its first char and its end.
    fn line(&self, index: usize) -> Option<Range<usize>>;
    /// Where char `index` is drawn, across its line, in pixels.
    fn x_of(&self, index: usize) -> Option<f32>;
    /// The char nearest `x` on the line `step` lines from `index`'s
    /// (−1 above, +1 below).
    fn vertical(&self, index: usize, step: isize, x: f32) -> Option<Vertical>;
}

/// What a keystroke is applied with.
pub(crate) struct KeyEnv<'a> {
    pub(crate) multiline: bool,
    /// A secure field never gives its text to the clipboard.
    pub(crate) secure: bool,
    pub(crate) clipboard: &'a mut dyn Clipboard,
    pub(crate) lines: Option<&'a dyn Lines>,
}

impl Field {
    /// Apply one keystroke. A key that edits ends a composition that is
    /// showing (an input method that takes the keyboard never lets one
    /// through mid-composition; a dead key's composition ends in the key
    /// that types the composed character).
    pub(crate) fn key(&mut self, keystroke: &Keystroke, env: &mut KeyEnv) -> Edit {
        let edit = self.apply_key(keystroke, env);
        if edit != Edit::None {
            self.preedit = None;
        }
        edit
    }

    fn apply_key(&mut self, keystroke: &Keystroke, env: &mut KeyEnv) -> Edit {
        let modifiers = keystroke.modifiers;
        let command = modifiers.control || modifiers.platform;
        let by_word = modifiers.control || modifiers.alt;
        let extend = modifiers.shift;
        let len = self.len();
        self.cursor = self.cursor.min(len);
        let selection = self.selection();
        match keystroke.key.as_str() {
            "backspace" => {
                if self.delete_selection() {
                    return Edit::Changed;
                }
                if self.cursor == 0 {
                    return Edit::None;
                }
                let from = if by_word {
                    word_start_before(&self.chars(), self.cursor)
                } else {
                    self.cursor - 1
                };
                self.remove(from..self.cursor);
                Edit::Changed
            }
            "delete" => {
                if self.delete_selection() {
                    return Edit::Changed;
                }
                if self.cursor >= len {
                    return Edit::None;
                }
                let to = if by_word {
                    word_end_after(&self.chars(), self.cursor)
                } else {
                    self.cursor + 1
                };
                self.remove(self.cursor..to);
                Edit::Changed
            }
            "left" => {
                let from = if extend { self.cursor } else { selection.start };
                let to = if by_word {
                    word_start_before(&self.chars(), from)
                } else if !extend && !selection.is_empty() {
                    selection.start
                } else {
                    from.saturating_sub(1)
                };
                self.move_to(to, extend);
                Edit::Moved
            }
            "right" => {
                let from = if extend { self.cursor } else { selection.end };
                let to = if by_word {
                    word_end_after(&self.chars(), from)
                } else if !extend && !selection.is_empty() {
                    selection.end
                } else {
                    (from + 1).min(len)
                };
                self.move_to(to, extend);
                Edit::Moved
            }
            "home" => {
                let to = if command {
                    0
                } else {
                    self.line_of(self.cursor, env).start
                };
                self.move_to(to, extend);
                Edit::Moved
            }
            "end" => {
                let to = if command {
                    len
                } else {
                    self.line_of(self.cursor, env).end
                };
                self.move_to(to, extend);
                Edit::Moved
            }
            "up" | "down" => {
                let step = if keystroke.key == "up" { -1 } else { 1 };
                if env.multiline {
                    self.vertical(step, extend, env.lines);
                    Edit::Moved
                } else if extend {
                    self.move_to(if step < 0 { 0 } else { len }, true);
                    Edit::Moved
                } else if step < 0 {
                    Edit::Key("ArrowUp")
                } else {
                    Edit::Key("ArrowDown")
                }
            }
            "enter" => {
                if env.multiline && !command {
                    self.insert_str("\n");
                    Edit::Changed
                } else {
                    Edit::Submitted
                }
            }
            "tab" => {
                if modifiers.shift {
                    Edit::FocusPrevious
                } else {
                    Edit::FocusNext
                }
            }
            "escape" => Edit::Key("Escape"),
            "a" if command => {
                self.select_all();
                Edit::Moved
            }
            "c" if command => {
                if env.secure || selection.is_empty() {
                    return Edit::None;
                }
                env.clipboard.write(self.selected_text());
                Edit::Handled
            }
            "x" if command => {
                if env.secure || selection.is_empty() {
                    return Edit::None;
                }
                env.clipboard.write(self.selected_text());
                self.delete_selection();
                Edit::Changed
            }
            "v" if command => match env.clipboard.read() {
                Some(text) => {
                    let text = if env.multiline {
                        text
                    } else {
                        text.replace('\n', " ")
                    };
                    self.insert_str(&text);
                    Edit::Changed
                }
                None => Edit::None,
            },
            "space" => {
                self.insert_str(" ");
                Edit::Changed
            }
            _ => {
                if command {
                    return Edit::None;
                }
                match keystroke.key_char.as_deref() {
                    Some(text) if !text.is_empty() && !text.chars().any(char::is_control) => {
                        self.insert_str(text);
                        Edit::Changed
                    }
                    _ => Edit::None,
                }
            }
        }
    }

    pub(super) fn chars(&self) -> Vec<char> {
        self.buffer.chars().collect()
    }

    /// The line holding char `index`: the whole text in a single-line
    /// field; the drawn line in a multiline one (its paragraph when it has
    /// not been drawn).
    fn line_of(&self, index: usize, env: &KeyEnv) -> Range<usize> {
        if !env.multiline {
            return 0..self.len();
        }
        env.lines
            .and_then(|lines| lines.line(index))
            .unwrap_or_else(|| paragraph_at(&self.chars(), index))
    }

    /// ↑ or ↓ in a multiline field: to the line above or below, keeping to
    /// the x the run of ↑/↓ began at; past the first line is the start, past
    /// the last the end. A selection not being extended collapses to the
    /// end it moves from.
    fn vertical(&mut self, step: isize, extend: bool, lines: Option<&dyn Lines>) {
        let selection = self.selection();
        let from = match (extend, step < 0) {
            (true, _) => self.cursor,
            (false, true) => selection.start,
            (false, false) => selection.end,
        };
        let chars = self.chars();
        let column = |index: usize| (index - paragraph_at(&chars, index).start) as f32;
        let x = match self.goal {
            Some((x, at)) if at == self.cursor => x,
            _ => lines
                .map_or(Some(column(from)), |lines| lines.x_of(from))
                .unwrap_or(0.0),
        };
        let target = match lines.and_then(|lines| lines.vertical(from, step, x)) {
            Some(Vertical::To(index)) => index,
            Some(Vertical::Past) if step < 0 => 0,
            Some(Vertical::Past) => chars.len(),
            None => paragraph_vertical(&chars, from, step, x as usize),
        };
        self.move_to(target, extend);
        self.goal = Some((x, self.cursor));
    }
}

/// ↑ or ↓ by paragraph, keeping to a column (a field not drawn yet).
fn paragraph_vertical(chars: &[char], from: usize, step: isize, column: usize) -> usize {
    let here = paragraph_at(chars, from);
    let there = if step < 0 {
        if here.start == 0 {
            return 0;
        }
        paragraph_at(chars, here.start - 1)
    } else {
        if here.end >= chars.len() {
            return chars.len();
        }
        paragraph_at(chars, here.end + 1)
    };
    there.start + column.min(there.len())
}
