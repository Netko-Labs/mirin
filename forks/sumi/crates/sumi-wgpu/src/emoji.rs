// mirin: emoji presentation (the whole file).
//! Which graphemes are drawn as emoji, and from which font. cosmic-text's
//! fallback on Linux lists Noto Sans Symbols before Noto Color Emoji, so a
//! character both have (U+1F610 😐, a few dozen faces and signs) came out as
//! a black outline among coloured neighbours. A grapheme that asks for emoji
//! presentation (`Emoji_Presentation=Yes` and no U+FE0E after it, or any
//! emoji followed by U+FE0F) is shaped with the colour font first; one that
//! asks for text (U+FE0E) is left to the text fonts.

use std::ops::Range;

use smallvec::SmallVec;
use unicode_properties::{UnicodeEmoji, emoji::EmojiStatus};
use unicode_segmentation::UnicodeSegmentation;

/// U+FE0E VARIATION SELECTOR-15: text presentation.
const TEXT_SELECTOR: char = '\u{fe0e}';
/// U+FE0F VARIATION SELECTOR-16: emoji presentation.
const EMOJI_SELECTOR: char = '\u{fe0f}';

/// Colour emoji families, the first installed one used.
const EMOJI_FAMILIES: [&str; 5] = [
    "Noto Color Emoji",
    "Twemoji",
    "Apple Color Emoji",
    "Segoe UI Emoji",
    "JoyPixels",
];

/// Whether `grapheme` is drawn as an emoji.
pub(crate) fn is_emoji_presentation(grapheme: &str) -> bool {
    let mut chars = grapheme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if grapheme.contains(TEXT_SELECTOR) {
        return false;
    }
    if grapheme.contains(EMOJI_SELECTOR) {
        return first.is_emoji_char_or_emoji_component();
    }
    matches!(
        first.emoji_status(),
        EmojiStatus::EmojiPresentation
            | EmojiStatus::EmojiPresentationAndModifierBase
            | EmojiStatus::EmojiPresentationAndEmojiComponent
            | EmojiStatus::EmojiPresentationAndModifierAndEmojiComponent
    )
}

/// How a grapheme asks to be drawn, where the fonts' own order would not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presentation {
    /// From the colour font.
    Emoji,
    /// From a text font that has this char (an emoji's base, with U+FE0E).
    Text(char),
}

/// The byte ranges of `text[range]` that ask for a presentation: emoji ones
/// joined where they meet, text ones (U+FE0E) one grapheme each.
pub(crate) fn presentations(
    text: &str,
    range: Range<usize>,
) -> SmallVec<[(Range<usize>, Presentation); 2]> {
    let mut out: SmallVec<[(Range<usize>, Presentation); 2]> = SmallVec::new();
    let Some(part) = text.get(range.clone()) else {
        return out;
    };
    // Every emoji is outside ASCII.
    if part.is_ascii() {
        return out;
    }
    for (at, grapheme) in part.grapheme_indices(true) {
        let piece = range.start + at..range.start + at + grapheme.len();
        let presentation = if is_emoji_presentation(grapheme) {
            Presentation::Emoji
        } else {
            match grapheme.chars().next() {
                Some(first) if grapheme.contains(TEXT_SELECTOR) && first.is_emoji_char() => {
                    Presentation::Text(first)
                }
                _ => continue,
            }
        };
        match out.last_mut() {
            Some((last, Presentation::Emoji))
                if presentation == Presentation::Emoji && last.end == piece.start =>
            {
                last.end = piece.end;
            }
            _ => out.push((piece, presentation)),
        }
    }
    out
}

/// The emoji ranges of `text[range]` alone.
#[cfg(test)]
fn emoji_ranges(text: &str, range: Range<usize>) -> SmallVec<[Range<usize>; 2]> {
    presentations(text, range)
        .into_iter()
        .filter(|(_, presentation)| *presentation == Presentation::Emoji)
        .map(|(range, _)| range)
        .collect()
}

/// Whether `face` is a colour emoji face (cosmic-text's own test: its
/// PostScript name says Emoji), or one of the known emoji families.
fn is_emoji_face(face: &cosmic_text::fontdb::FaceInfo) -> bool {
    face.post_script_name.contains("Emoji")
        || face
            .families
            .iter()
            .any(|(name, _)| EMOJI_FAMILIES.contains(&name.as_str()))
}

/// The family of the first text face (not an emoji one) that has `ch`.
/// Read from each face's character map, so only for a char asked for as
/// text, and once (the caller keeps the answer).
pub(crate) fn text_family(db: &cosmic_text::fontdb::Database, ch: char) -> Option<String> {
    db.faces()
        .filter(|face| !is_emoji_face(face))
        .find(|face| {
            db.with_face_data(face.id, |data, index| {
                swash::FontRef::from_index(data, index as usize)
                    .is_some_and(|font| font.charmap().map(ch) != 0)
            })
            .unwrap_or(false)
        })
        .and_then(|face| face.families.first())
        .map(|(name, _)| name.clone())
}

/// The installed colour emoji family, if one is: the family of a face sumi
/// takes for an emoji font (PostScript name `NotoColorEmoji`, as
/// `check_is_known_emoji_font`), else the first of `EMOJI_FAMILIES`.
pub(crate) fn emoji_family(db: &cosmic_text::fontdb::Database) -> Option<String> {
    let known = db
        .faces()
        .find(|face| face.post_script_name == "NotoColorEmoji")
        .and_then(|face| face.families.first())
        .map(|(name, _)| name.clone());
    known.or_else(|| {
        EMOJI_FAMILIES
            .iter()
            .find(|family| {
                db.faces()
                    .any(|face| face.families.iter().any(|(name, _)| name == *family))
            })
            .map(|family| (*family).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::{Presentation, emoji_ranges, is_emoji_presentation, presentations};

    #[test]
    fn a_face_with_emoji_presentation_is_an_emoji_alone() {
        // U+1F610 NEUTRAL FACE: Emoji_Presentation=Yes, no selector needed.
        assert!(is_emoji_presentation("😐"));
        assert!(is_emoji_presentation("❤️"));
        assert!(is_emoji_presentation("🇨🇴"));
        assert!(is_emoji_presentation("👍🏽"));
        assert!(is_emoji_presentation("1️⃣"));
    }

    #[test]
    fn text_presentation_stays_text() {
        // U+2764 alone is text by default; U+FE0E asks for text.
        assert!(!is_emoji_presentation("❤"));
        assert!(!is_emoji_presentation("😐\u{fe0e}"));
        assert!(!is_emoji_presentation("a"));
        assert!(!is_emoji_presentation("1"));
        assert!(!is_emoji_presentation("©"));
    }

    #[test]
    fn ranges_are_bytes_of_the_text_and_neighbours_join() {
        let text = "ok 😐😀 and ❤ ❤️";
        let ranges = emoji_ranges(text, 0..text.len());
        let face = text.find('😐').expect("a face");
        let heart = text.rfind('❤').expect("a heart");
        assert_eq!(
            ranges.as_slice(),
            &[face..face + 8, heart..heart + "❤️".len()]
        );
        assert!(emoji_ranges("plain", 0..5).is_empty());
        // Only the asked part.
        assert!(emoji_ranges(text, 0..3).is_empty());
    }

    #[test]
    fn an_emoji_asked_for_as_text_is_its_own_range() {
        let text = "a😐\u{fe0e}😐";
        let found = presentations(text, 0..text.len());
        assert_eq!(
            found.as_slice(),
            &[
                (1..8, Presentation::Text('😐')),
                (8..12, Presentation::Emoji)
            ]
        );
        // A plain char with U+FE0E is no emoji: nothing to ask.
        assert!(presentations("a\u{fe0e}", 0..4).is_empty());
    }
}
