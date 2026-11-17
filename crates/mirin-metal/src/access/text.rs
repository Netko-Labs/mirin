//! A field's text as AccessKit text runs: what gives a field AT-SPI's
//! `Text` (its words, the caret, the selection, the character count and
//! the `text-changed` / `text-caret-moved` events) and `EditableText`.
//!
//! - One run a line: a line's run ends with its line break, which counts
//!   as one character, and the caret at a line's end is on that break
//!   (AccessKit's rule). A line longer than a run holds (a run counts its
//!   words in bytes) goes on in more runs on the same line.
//! - A character is a Unicode scalar value, as the field's caret moves
//!   (`field.rs` counts chars), so an AT-SPI offset is a field char index.
//! - A word starts at a character that is not a space after one that is,
//!   and at the start of each line; trailing spaces belong to the word
//!   before them, as AccessKit asks.
//! - A secure field's runs hold one bullet a character: its length is
//!   published, never its characters (`tree::field_node`).
//!
//! Runs carry no bounds: the field's own bounds stand for them (no caret
//! rectangle yet; docs/metal.md "Not yet").

use accesskit::{Node, NodeId, Role, TextPosition, TextSelection};

use super::tree::node_id;

/// The most characters one run holds: a run's word starts are bytes.
const RUN_CHARS: usize = 255;

/// A field's text laid out as runs.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Laid {
    /// The runs, in order, with their nodes.
    pub runs: Vec<(NodeId, Node)>,
    /// Where each run starts, in the field's chars.
    pub starts: Vec<usize>,
    /// The caret and the selection, when the field has them.
    pub selection: Option<TextSelection>,
}

impl Laid {
    /// The runs' ids: the field's children.
    pub(crate) fn ids(&self) -> Vec<NodeId> {
        self.runs.iter().map(|(id, _)| *id).collect()
    }
}

/// The id of run `index` of the field `field`.
fn run_id(field: NodeId, index: usize) -> NodeId {
    node_id(&format!("{:x}\u{1f}run\u{1f}{index}", field.0))
}

/// Field `field`'s `text` as runs, with the selection from `anchor` to
/// `focus` (char indices; the caret is `focus`) when it is given.
pub(crate) fn lay(field: NodeId, text: &str, selection: Option<(usize, usize)>) -> Laid {
    let mut laid = Laid::default();
    let mut start = 0;
    // The char before the run being made: a word starts after a space.
    let mut before: Option<char> = None;
    for line in text.split_inclusive('\n') {
        let chars: Vec<char> = line.chars().collect();
        let pieces: Vec<&[char]> = chars.chunks(RUN_CHARS).collect();
        let last_piece = pieces.len().saturating_sub(1);
        for (piece, run) in pieces.iter().enumerate() {
            let index = laid.runs.len();
            let mut node = Node::new(Role::TextRun);
            node.set_value(run.iter().collect::<String>());
            let lengths: Vec<u8> = run.iter().map(|ch| ch.len_utf8() as u8).collect();
            node.set_character_lengths(lengths);
            node.set_word_starts(word_starts(run, before.filter(|_| piece > 0)));
            if piece > 0 {
                node.set_previous_on_line(run_id(field, index - 1));
            }
            if piece < last_piece {
                node.set_next_on_line(run_id(field, index + 1));
            }
            before = run.last().copied();
            laid.runs.push((run_id(field, index), node));
            laid.starts.push(start);
            start += run.len();
        }
    }
    if laid.runs.is_empty() || text.ends_with('\n') {
        // An empty field, or an empty last line: a run with no characters,
        // so there is a place for the caret.
        let mut node = Node::new(Role::TextRun);
        node.set_value("");
        node.set_character_lengths(Vec::<u8>::new());
        let index = laid.runs.len();
        laid.runs.push((run_id(field, index), node));
        laid.starts.push(start);
    }
    laid.selection = selection.map(|(anchor, focus)| TextSelection {
        anchor: position(&laid, anchor),
        focus: position(&laid, focus),
    });
    laid
}

/// Where in the runs field char `at` is (clamped to the text's end).
fn position(laid: &Laid, at: usize) -> TextPosition {
    // The run holding `at`: the last that starts at or before it. A char
    // past a run's end is the next run's first.
    let run = laid.starts.partition_point(|start| *start <= at).max(1) - 1;
    let (id, node) = &laid.runs[run];
    let length = node.character_lengths().len();
    TextPosition {
        node: *id,
        character_index: (at - laid.starts[run]).min(length),
    }
}

/// The char of a field's text at `position`, when it names one of `laid`'s runs.
#[cfg(test)]
pub(crate) fn char_at(laid: &Laid, position: TextPosition) -> Option<usize> {
    let run = laid.runs.iter().position(|(id, _)| *id == position.node)?;
    Some(laid.starts[run] + position.character_index)
}

/// Where words start in `run`, whose char before is `before` (none at a
/// line's start, where a word always starts).
fn word_starts(run: &[char], before: Option<char>) -> Vec<u8> {
    let mut previous = before;
    let mut starts = Vec::new();
    for (index, ch) in run.iter().enumerate() {
        let starts_word = match previous {
            None => index == 0,
            Some(previous) => previous.is_whitespace() && !ch.is_whitespace(),
        };
        if starts_word {
            // A run holds at most `RUN_CHARS` chars: the index fits.
            starts.push(index as u8);
        }
        previous = Some(*ch);
    }
    starts
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIELD: NodeId = NodeId(7);

    fn values(laid: &Laid) -> Vec<&str> {
        laid.runs
            .iter()
            .map(|(_, node)| node.value().unwrap_or_default())
            .collect()
    }

    #[test]
    fn a_line_is_a_run_ending_with_its_break() {
        let laid = lay(FIELD, "buy milk\nand eggs", None);
        assert_eq!(values(&laid), ["buy milk\n", "and eggs"]);
        assert_eq!(laid.starts, [0, 9]);
        let first = &laid.runs[0].1;
        assert_eq!(first.character_lengths().len(), 9, "the break is one char");
        assert_eq!(first.word_starts(), &[0, 4]);
        assert_eq!(laid.selection, None);
    }

    #[test]
    fn an_empty_field_has_one_empty_run_for_the_caret() {
        let laid = lay(FIELD, "", Some((0, 0)));
        assert_eq!(values(&laid), [""]);
        let caret = TextPosition {
            node: laid.runs[0].0,
            character_index: 0,
        };
        assert_eq!(
            laid.selection,
            Some(TextSelection {
                anchor: caret,
                focus: caret
            })
        );
    }

    #[test]
    fn the_caret_after_a_last_break_is_on_an_empty_line() {
        let laid = lay(FIELD, "one\n", Some((4, 4)));
        assert_eq!(values(&laid), ["one\n", ""]);
        let focus = laid.selection.unwrap().focus;
        assert_eq!(focus.node, laid.runs[1].0);
        assert_eq!(char_at(&laid, focus), Some(4));
    }

    #[test]
    fn a_selection_across_lines_names_both_runs() {
        let laid = lay(FIELD, "ab\ncd", Some((1, 4)));
        let selection = laid.selection.unwrap();
        assert_eq!(selection.anchor.node, laid.runs[0].0);
        assert_eq!(selection.anchor.character_index, 1);
        assert_eq!(selection.focus.node, laid.runs[1].0);
        assert_eq!(selection.focus.character_index, 1);
        assert_eq!(char_at(&laid, selection.anchor), Some(1));
        assert_eq!(char_at(&laid, selection.focus), Some(4));
        // The caret at a line's end is on its break (index 2 of "ab\n").
        let end = lay(FIELD, "ab\ncd", Some((2, 2))).selection.unwrap().focus;
        assert_eq!(end.character_index, 2);
        // Past the text: its end.
        let past = lay(FIELD, "ab", Some((9, 9))).selection.unwrap().focus;
        assert_eq!(past.character_index, 2);
    }

    #[test]
    fn a_long_line_goes_on_in_runs_on_the_same_line() {
        let text = "word ".repeat(120);
        let laid = lay(FIELD, &text, None);
        assert_eq!(laid.runs.len(), 3);
        assert_eq!(laid.starts, [0, 255, 510]);
        let (first, second) = (&laid.runs[0].1, &laid.runs[1].1);
        assert_eq!(first.next_on_line(), Some(laid.runs[1].0));
        assert_eq!(second.previous_on_line(), Some(laid.runs[0].0));
        // 255 = 51 words of five: the second run starts on a word.
        assert_eq!(second.word_starts().first(), Some(&0));
        let total: usize = laid
            .runs
            .iter()
            .map(|(_, node)| node.character_lengths().len())
            .sum();
        assert_eq!(total, 600);
    }

    #[test]
    fn characters_are_scalar_values_with_their_byte_lengths() {
        let laid = lay(FIELD, "né 😐", None);
        let run = &laid.runs[0].1;
        assert_eq!(run.character_lengths(), &[1, 2, 1, 4]);
        assert_eq!(run.word_starts(), &[0, 3]);
    }

    #[test]
    fn run_ids_are_stable_and_apart_from_the_fields() {
        assert_eq!(lay(FIELD, "a", None).ids(), lay(FIELD, "b", None).ids());
        assert_ne!(lay(FIELD, "a", None).ids(), lay(NodeId(8), "a", None).ids());
        assert!(!lay(FIELD, "a", None).ids().contains(&FIELD));
    }
}
