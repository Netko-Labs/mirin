//! What the pointer does to a field: a click puts the caret at a
//! character, a double click selects a word, a triple click the line (the
//! paragraph in a multiline field), a ⇧-click extends the selection, and a
//! drag selects from where it was pressed, by the unit the press chose.

use std::ops::Range;

use super::words::{paragraph_at, word_at};
use super::Field;

/// What a selection grows by while the button is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Char,
    Word,
    Line,
}

/// A press that has not been released: what it first selected, and by what
/// unit a drag grows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Press {
    unit: Unit,
    origin: Range<usize>,
}

impl Field {
    /// A press at char `at`, the `clicks`th in a row (1, 2, 3, …), with or
    /// without ⇧. A composition showing becomes text first, where it
    /// shows. Returns the press, for a drag, and whether the text changed
    /// (that composition).
    pub(crate) fn press(
        &mut self,
        at: usize,
        clicks: usize,
        extend: bool,
        multiline: bool,
    ) -> (Press, bool) {
        let mut at = at;
        let changed = match self.preedit.as_deref().map(|text| text.chars().count()) {
            Some(composed) => {
                if at > self.cursor {
                    at += composed;
                }
                self.unmark(multiline)
            }
            None => false,
        };
        self.goal = None;
        let press = if extend {
            let anchor = self.anchor.unwrap_or(self.cursor);
            self.select(anchor, at);
            Press {
                unit: Unit::Char,
                origin: anchor..anchor,
            }
        } else {
            let unit = match clicks {
                0 | 1 => Unit::Char,
                2 => Unit::Word,
                _ => Unit::Line,
            };
            let origin = self.unit_at(unit, at, multiline);
            self.select(origin.start, origin.end);
            Press { unit, origin }
        };
        (press, changed)
    }

    /// The pointer moved to char `at` with the button held: the selection
    /// runs from the press's first selection to the unit under the pointer.
    pub(crate) fn drag(&mut self, press: &Press, at: usize, multiline: bool) {
        let here = self.unit_at(press.unit, at, multiline);
        if here.start < press.origin.start {
            self.select(press.origin.end, here.start);
        } else {
            self.select(press.origin.start, here.end.max(press.origin.end));
        }
    }

    fn unit_at(&self, unit: Unit, at: usize, multiline: bool) -> Range<usize> {
        let at = at.min(self.len());
        match unit {
            Unit::Char => at..at,
            Unit::Word => word_at(&self.chars(), at),
            Unit::Line if multiline => paragraph_at(&self.chars(), at),
            Unit::Line => 0..self.len(),
        }
    }
}
