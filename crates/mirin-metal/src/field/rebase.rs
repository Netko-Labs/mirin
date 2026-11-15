//! A field's edit carried onto a text the driver wrote meanwhile.
//!
//! A field's text has two writers: the person, typing in the renderer, and
//! the app, setting `value`. When they cross (the app wrote before it heard
//! what was typed, and the typing happened before the write arrived), the
//! field holds an edit of a text the app has since replaced. Resetting to
//! the app's text would lose the keys; keeping the field's would lose the
//! app's write. Both are kept: what the person did to the old text is done
//! again to the app's.
//!
//! Each side's change is read as one splice of the text both knew (`known`):
//! the part between the longest shared start and end, replaced. The
//! person's splice then lands in the app's text where its place went:
//! unmoved before what the app replaced, shifted after it, and right after
//! the app's own text when it began inside what the app replaced or at the
//! same point (a keypad wrote "7" where the person typed "*": "7*").

/// The field's text and caret (a char index) after a rebase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rebased {
    pub(crate) text: String,
    pub(crate) cursor: usize,
}

/// One side's change to the known text: chars `start..end` of it replaced
/// by `count` chars.
struct Splice {
    start: usize,
    end: usize,
    count: usize,
}

/// `from` into `to` as one splice: what is between their longest shared
/// start and, of the rest, their longest shared end.
fn splice(from: &[char], to: &[char]) -> Splice {
    let shortest = from.len().min(to.len());
    let start = from
        .iter()
        .zip(to)
        .take_while(|(old, new)| old == new)
        .count();
    let tail = from
        .iter()
        .rev()
        .zip(to.iter().rev())
        .take(shortest - start)
        .take_while(|(old, new)| old == new)
        .count();
    Splice {
        start,
        end: from.len() - tail,
        count: to.len() - tail - start,
    }
}

/// The field edited `known` into `held` (its caret at char `cursor`) while
/// the driver replaced `known` with `written`: the driver's text with the
/// field's edit in it, and where the caret is now.
pub(crate) fn rebase(known: &str, held: &str, cursor: usize, written: &str) -> Rebased {
    let known: Vec<char> = known.chars().collect();
    let held: Vec<char> = held.chars().collect();
    let written: Vec<char> = written.chars().collect();
    let typed = splice(&known, &held);
    let wrote = splice(&known, &written);
    let typed_text = &held[typed.start..typed.start + typed.count];
    let wrote_text = &written[wrote.start..wrote.start + wrote.count];
    // What follows both splices in the known text is the end of the result.
    let tail = typed.end.max(wrote.end);

    let mut text: Vec<char> = Vec::with_capacity(written.len() + typed.count);
    let typed_at;
    if typed.start < wrote.start {
        // The edit began in text the app left alone: it stays there, and
        // takes with it only what the app left of what it removed.
        text.extend(&known[..typed.start]);
        typed_at = text.len();
        text.extend(typed_text);
        text.extend(&known[typed.end.min(wrote.start)..wrote.start]);
        text.extend(wrote_text);
    } else if typed.start >= wrote.end {
        // After what the app replaced (or at the very point it wrote).
        text.extend(&known[..wrote.start]);
        text.extend(wrote_text);
        text.extend(&known[wrote.end..typed.start]);
        typed_at = text.len();
        text.extend(typed_text);
    } else {
        // Inside what the app replaced: right after the app's own text.
        text.extend(&known[..wrote.start]);
        text.extend(wrote_text);
        typed_at = text.len();
        text.extend(typed_text);
    }
    let body = text.len();
    text.extend(&known[tail..]);

    let cursor = cursor.min(held.len());
    let cursor = if cursor >= typed.start && cursor <= typed.start + typed.count {
        // In what was typed, or at either end of it.
        typed_at + (cursor - typed.start)
    } else if cursor < typed.start {
        // Before the edit, where the app's write left that place.
        if cursor <= wrote.start {
            cursor
        } else if cursor >= wrote.end {
            cursor - (wrote.end - wrote.start) + wrote.count
        } else {
            wrote.start + wrote.count
        }
    } else {
        // After the edit, at char `at` of the known text.
        let at = cursor - typed.count + (typed.end - typed.start);
        if at >= tail {
            text.len() - (known.len() - at)
        } else {
            body
        }
    };
    Rebased {
        text: text.into_iter().collect(),
        cursor,
    }
}

#[cfg(test)]
mod tests {
    use super::{rebase, Rebased};

    /// The caret at the end of `held`, as after typing there.
    fn typed(known: &str, held: &str, written: &str) -> String {
        rebase(known, held, held.chars().count(), written).text
    }

    #[test]
    fn what_was_typed_goes_after_what_the_app_wrote_at_the_same_point() {
        // Calculator: the keypad wrote "7" into the empty line while "*6="
        // was typed into it.
        assert_eq!(
            rebase("", "*6=", 3, "7"),
            Rebased {
                text: "7*6=".into(),
                cursor: 4
            }
        );
        // And with something there already: "5", then 7 on the keypad and * typed.
        assert_eq!(typed("5", "5*", "57"), "57*");
    }

    #[test]
    fn typing_before_or_after_the_apps_write_keeps_its_place() {
        // The app tidied "1250" to "1,250" while a 3 was typed at its end.
        assert_eq!(typed("1250", "12503", "1,250"), "1,2503");
        // Typed at the start while the app appended.
        assert_eq!(
            rebase("world", "hello world", 6, "world!"),
            Rebased {
                text: "hello world!".into(),
                cursor: 6
            }
        );
    }

    #[test]
    fn typing_into_a_text_the_app_cleared_is_kept() {
        // Enter submitted "abc" and the app cleared the field; "d" was typed meanwhile.
        assert_eq!(typed("abc", "abcd", ""), "d");
        // Typed at its start: there is one place left.
        assert_eq!(rebase("abc", "dabc", 1, "").text, "d");
        // Typed in its middle: after what the app put there.
        assert_eq!(rebase("abc", "abdc", 3, "xyz").text, "xyzd");
    }

    #[test]
    fn a_deletion_takes_only_what_the_app_left() {
        // Backspace over "c" while the app appended "!".
        assert_eq!(typed("abc", "ab", "abc!"), "ab!");
        // The person removed "bcd"; the app replaced "cde" with "X": "b" goes, "X" stays.
        assert_eq!(rebase("abcdef", "aef", 1, "abXf").text, "aXf");
        // The app removed what the person was replacing: the typed text is kept.
        assert_eq!(rebase("abcdef", "abZef", 3, "aef").text, "aZef");
    }

    #[test]
    fn the_caret_stays_with_the_text_it_was_in() {
        // The caret before the edit, in text the app pushed along.
        let rebased = rebase("ab", "abc", 0, "xxab");
        assert_eq!((rebased.text.as_str(), rebased.cursor), ("xxabc", 0));
        let rebased = rebase("ab", "abc", 1, "xxab");
        assert_eq!((rebased.text.as_str(), rebased.cursor), ("xxabc", 3));
        // The caret after the edit, left there by a click: it keeps its distance to the end.
        let rebased = rebase("one two", "one, two", 8, "ONE two");
        assert_eq!((rebased.text.as_str(), rebased.cursor), ("ONE, two", 8));
    }

    #[test]
    fn characters_are_whole_whatever_their_bytes() {
        assert_eq!(
            rebase("é", "é😀", 2, "ñé"),
            Rebased {
                text: "ñé😀".into(),
                cursor: 3
            }
        );
    }

    #[test]
    fn nothing_typed_is_the_apps_text() {
        assert_eq!(
            rebase("abc", "abc", 3, "xyz"),
            Rebased {
                text: "xyz".into(),
                cursor: 3
            }
        );
    }
}
