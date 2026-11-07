//! Highlights and line numbers: where the driver's offsets land in the
//! drawn text, and which lines a clip shows.

use gpui::{point, px, size, Bounds, Pixels, Point};

use super::{highlight_ranges, line_starts, utf16_bytes, visible_bytes, visible_part};
use crate::caret::Laid;
use crate::field::Field;
use crate::tree::Highlight;

/// One drawn line per line of the text (no wrapping), each char 10 px wide
/// and every line 20 tall. ASCII only.
struct Rows {
    /// Each line's first and end byte.
    lines: Vec<(usize, usize)>,
}

impl Rows {
    fn new(text: &str) -> Self {
        let mut lines = Vec::new();
        let mut start = 0;
        for line in text.split('\n') {
            lines.push((start, start + line.len()));
            start += line.len() + 1;
        }
        Self { lines }
    }
}

impl Laid for Rows {
    fn position(&self, index: usize) -> Option<Point<Pixels>> {
        let row = self
            .lines
            .iter()
            .position(|&(start, end)| start <= index && index <= end)?;
        let (start, _) = self.lines[row];
        Some(point(
            px((index - start) as f32 * 10.0),
            px(row as f32 * 20.0),
        ))
    }

    fn hit(&self, position: Point<Pixels>) -> usize {
        let row = (f32::from(position.y) / 20.0).max(0.0) as usize;
        let (start, end) = self.lines[row.min(self.lines.len() - 1)];
        let column = (f32::from(position.x) / 10.0).round().max(0.0) as usize;
        (start + column).min(end)
    }

    fn line_height(&self) -> Pixels {
        px(20.0)
    }

    fn bounds(&self) -> Bounds<Pixels> {
        let width = self.lines.iter().map(|(s, e)| e - s).max().unwrap_or(0);
        Bounds::new(
            point(px(0.0), px(0.0)),
            size(px(width as f32 * 10.0), px(self.lines.len() as f32 * 20.0)),
        )
    }
}

fn highlight(start: usize, end: usize, color: &str) -> Highlight {
    Highlight {
        start,
        end,
        color: color.to_owned(),
    }
}

#[test]
fn utf16_offsets_land_on_character_starts_in_one_pass() {
    // a (1 unit, 1 byte), é (1 unit, 2 bytes), 😀 (2 units, 4 bytes), b.
    let text = "aé😀b";
    let offsets = [4, 0, 3, 1, 2, 5, 99];
    // Inside the emoji's pair is its start; past the end is the end.
    assert_eq!(utf16_bytes(text, &offsets), vec![7, 0, 3, 1, 3, 8, 8]);
    assert_eq!(utf16_bytes("", &[0, 3]), vec![0, 0]);
}

#[test]
fn highlights_are_drawn_where_their_text_is() {
    let field = Field::new("find the word, the end");
    let display = field.display(false, false);
    let ranges = highlight_ranges(
        &field.buffer,
        &display,
        &[
            highlight(15, 18, "#ffcc0080"),
            highlight(5, 8, "#ffcc0040"),
            // Empty, and a color that doesn't parse: left out.
            highlight(3, 3, "#ffcc0040"),
            highlight(0, 4, "yellow"),
        ],
    );
    assert_eq!(ranges, vec![(5..8, 0xffcc_0040), (15..18, 0xffcc_0080)]);
}

#[test]
fn a_composition_at_the_caret_pushes_later_highlights_along() {
    // "ab|cd" with "xy" being composed at the caret: "cd" is drawn two bytes on.
    let mut field = Field::new("abcd");
    field.place(2);
    field.preedit = Some("xy".to_owned());
    let display = field.display(true, false);
    assert_eq!(display.text, "abxycd");
    let ranges = highlight_ranges(
        &field.buffer,
        &display,
        &[highlight(0, 1, "#ff0000"), highlight(2, 4, "#00ff00")],
    );
    assert_eq!(ranges[0].0, 0..1);
    assert_eq!(&display.text[ranges[1].0.clone()], "cd");
}

#[test]
fn the_lines_a_clip_shows_are_found_by_hit_testing() {
    let text = "one\ntwo\nthree\nfour\nfive";
    let rows = Rows::new(text);
    // Rows 1 and 2 (ys 20..60) are "two" and "three".
    assert_eq!(visible_bytes(&rows, px(25.0), px(55.0)), Some(4..13));
    // A clip past the text's end shows none of it.
    assert_eq!(visible_bytes(&rows, px(200.0), px(300.0)), None);
    // A clip taller than the text shows all of it.
    assert_eq!(
        visible_bytes(&rows, px(-50.0), px(500.0)),
        Some(0..text.len())
    );
}

#[test]
fn line_numbers_count_from_the_text_start() {
    let text = "one\ntwo\n\nfour\n";
    // From inside "two" to the start of "four": lines 2 to 4.
    assert_eq!(line_starts(text, 5..9), vec![(4, 2), (8, 3), (9, 4)]);
    // The empty line after a final line break has a number too.
    assert_eq!(line_starts(text, 9..text.len()), vec![(9, 4), (14, 5)]);
    assert_eq!(line_starts("", 0..0), vec![(0, 1)]);
}

#[test]
fn a_highlight_is_drawn_only_on_the_lines_shown() {
    let text = "aaa\nbbb\nccc\nddd";
    // Lines "bbb" and "ccc" shown.
    let seen = 4..11;
    assert_eq!(visible_part(text, &(0..2), &seen), None);
    assert_eq!(visible_part(text, &(5..6), &seen), Some(5..6));
    // From above the clip to below it: cut to the shown lines and their break.
    assert_eq!(visible_part(text, &(1..15), &seen), Some(4..12));
    assert_eq!(visible_part(text, &(13..15), &seen), None);
}
