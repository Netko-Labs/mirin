//! Words and paragraphs in a field's text, as char indices: where ⌥← and
//! ⌥→ stop, what a double click selects (a word, a run of spaces, a run of
//! punctuation), and what a triple click selects (a paragraph).

use std::ops::Range;

/// What a character is, for finding words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Word,
    Space,
    Newline,
    Other,
}

fn class(ch: char) -> Class {
    if ch == '\n' {
        Class::Newline
    } else if ch.is_whitespace() {
        Class::Space
    } else if ch.is_alphanumeric() || ch == '_' {
        Class::Word
    } else {
        Class::Other
    }
}

/// Where ⌥← stops from `from`: the start of the word it is in or after,
/// past any spaces and punctuation before it.
pub(super) fn word_start_before(chars: &[char], from: usize) -> usize {
    let mut at = from.min(chars.len());
    while at > 0 && class(chars[at - 1]) != Class::Word {
        at -= 1;
    }
    while at > 0 && class(chars[at - 1]) == Class::Word {
        at -= 1;
    }
    at
}

/// Where ⌥→ stops from `from`: the end of the word it is in or before,
/// past any spaces and punctuation after it.
pub(super) fn word_end_after(chars: &[char], from: usize) -> usize {
    let mut at = from.min(chars.len());
    while at < chars.len() && class(chars[at]) != Class::Word {
        at += 1;
    }
    while at < chars.len() && class(chars[at]) == Class::Word {
        at += 1;
    }
    at
}

/// What a double click at `index` selects: the run of like characters
/// there (a word, spaces, punctuation). At a line's end it is the run
/// before; on an empty line, nothing.
pub(super) fn word_at(chars: &[char], index: usize) -> Range<usize> {
    let index = index.min(chars.len());
    let at = match chars.get(index) {
        Some(&ch) if class(ch) != Class::Newline => index,
        _ if index > 0 && class(chars[index - 1]) != Class::Newline => index - 1,
        _ => return index..index,
    };
    let kind = class(chars[at]);
    let mut start = at;
    while start > 0 && class(chars[start - 1]) == kind {
        start -= 1;
    }
    let mut end = at + 1;
    while end < chars.len() && class(chars[end]) == kind {
        end += 1;
    }
    start..end
}

/// The paragraph holding `index`: from the line break before it to the one
/// after it, neither included.
pub(super) fn paragraph_at(chars: &[char], index: usize) -> Range<usize> {
    let index = index.min(chars.len());
    let start = chars[..index]
        .iter()
        .rposition(|&ch| ch == '\n')
        .map_or(0, |at| at + 1);
    let end = chars[index..]
        .iter()
        .position(|&ch| ch == '\n')
        .map_or(chars.len(), |at| index + at);
    start..end
}
