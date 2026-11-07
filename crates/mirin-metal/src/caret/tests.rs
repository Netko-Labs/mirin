//! The caret and the selection over a laid-out text: drawn beside the
//! glyphs, never in them.

use gpui::{point, px, size, Bounds, Pixels, Point};

use super::{caret_bar, caret_point, selection_rects, Laid};
use crate::field::Field;

/// Every char 10 px wide and 20 tall, `width` chars to a line before it
/// wraps, a line break starting a new one; at a wrap, a position is the end
/// of the line above, as GPUI answers. ASCII only.
struct Mono {
    /// Each drawn line's first and end byte.
    lines: Vec<(usize, usize)>,
}

const CHAR: f32 = 10.0;
const LINE: f32 = 20.0;

impl Mono {
    fn new(text: &str, width: usize) -> Self {
        let mut lines = Vec::new();
        let mut start = 0;
        for paragraph in text.split('\n') {
            let mut from = start;
            let end = start + paragraph.len();
            while end - from > width {
                lines.push((from, from + width));
                from += width;
            }
            lines.push((from, end));
            start = end + 1;
        }
        Self { lines }
    }
}

impl Laid for Mono {
    fn position(&self, index: usize) -> Option<Point<Pixels>> {
        let row = self
            .lines
            .iter()
            .position(|&(start, end)| start <= index && index <= end)?;
        let (start, _) = self.lines[row];
        Some(point(
            px((index - start) as f32 * CHAR),
            px(row as f32 * LINE),
        ))
    }

    fn hit(&self, position: Point<Pixels>) -> usize {
        let row = (f32::from(position.y) / LINE).max(0.0) as usize;
        let (start, end) = self.lines[row.min(self.lines.len() - 1)];
        let column = (f32::from(position.x) / CHAR).round().max(0.0) as usize;
        (start + column).min(end)
    }

    fn line_height(&self) -> Pixels {
        px(LINE)
    }

    fn bounds(&self) -> Bounds<Pixels> {
        let width = self.lines.iter().map(|(s, e)| e - s).max().unwrap_or(0);
        Bounds::new(
            point(px(0.0), px(0.0)),
            size(px(width as f32 * CHAR), px(self.lines.len() as f32 * LINE)),
        )
    }
}

fn rect(x: f32, y: f32, width: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(x), px(y)), size(px(width), px(LINE)))
}

#[test]
fn the_caret_takes_no_room_in_the_text() {
    // Wherever the caret is, and whatever is selected, the text drawn is the
    // buffer: nothing after the caret moves when it does.
    let mut field = Field::new("one two three");
    for cursor in 0..=13 {
        field.place(cursor);
        let display = field.display(true, false);
        assert_eq!(display.text, "one two three");
        assert_eq!(display.caret, Some(cursor));
    }
    field.select(4, 7);
    assert_eq!(field.display(true, false).text, "one two three");
    // So the caret sits on the boundary between the glyphs, and the glyphs
    // after it are where they were.
    let laid = Mono::new("one two three", 40);
    let bar = caret_bar(&laid, "one two three", 6, px(1.5)).unwrap();
    assert_eq!(bar.origin, point(px(60.0), px(0.0)));
    assert_eq!(bar.size, size(px(1.5), px(LINE)));
    assert_eq!(laid.position(7), Some(point(px(70.0), px(0.0))));
}

#[test]
fn moving_the_caret_on_a_wrapped_line_never_reflows_it() {
    let text = "the line is long enough to wrap";
    let mut field = Field::new(text);
    let before = field.display(true, false).text;
    field.place(26);
    assert_eq!(field.display(true, false).text, before);
    field.place(27);
    assert_eq!(field.display(true, false).text, before);
}

#[test]
fn at_a_soft_wrap_the_caret_starts_the_next_line() {
    // "abcd" then "efgh": byte 4 is both the end of the first line and the
    // start of the second; the caret before "e" is drawn beside it.
    let text = "abcdefgh";
    let laid = Mono::new(text, 4);
    assert_eq!(laid.position(4), Some(point(px(40.0), px(0.0))));
    assert_eq!(caret_point(&laid, text, 4), Some(point(px(0.0), px(LINE))));
    // Mid-line, and at the very end, it is where GPUI says.
    assert_eq!(caret_point(&laid, text, 3), Some(point(px(30.0), px(0.0))));
    assert_eq!(caret_point(&laid, text, 8), Some(point(px(40.0), px(LINE))));
    // Before a line break, the caret ends its own line.
    let text = "ab\ncd";
    let laid = Mono::new(text, 10);
    assert_eq!(caret_point(&laid, text, 2), Some(point(px(20.0), px(0.0))));
    assert_eq!(caret_point(&laid, text, 3), Some(point(px(0.0), px(LINE))));
}

#[test]
fn a_selection_is_washed_line_by_line() {
    // "abcd|efgh" wrapped, then a line break, then "ij".
    let text = "abcdefgh\nij";
    let laid = Mono::new(text, 4);
    // Within a line.
    assert_eq!(
        selection_rects(&laid, text, 1..3, px(4.0)),
        vec![rect(10.0, 0.0, 20.0)]
    );
    // Across the wrap, the line break, and into the last line.
    assert_eq!(
        selection_rects(&laid, text, 2..10, px(4.0)),
        vec![
            rect(20.0, 0.0, 20.0),
            rect(0.0, LINE, 44.0),
            rect(0.0, 2.0 * LINE, 10.0),
        ]
    );
    // An empty line selected through shows its line break.
    let text = "a\n\nb";
    let laid = Mono::new(text, 10);
    assert_eq!(
        selection_rects(&laid, text, 0..4, px(4.0)),
        vec![
            rect(0.0, 0.0, 14.0),
            rect(0.0, LINE, 4.0),
            rect(0.0, 2.0 * LINE, 10.0),
        ]
    );
    // Nothing selected, nothing washed.
    assert!(selection_rects(&laid, text, 2..2, px(4.0)).is_empty());
}

#[test]
fn a_secure_fields_selection_is_drawn_over_its_bullets() {
    let mut field = Field::new("secret");
    field.select_all();
    let display = field.display(true, true);
    assert_eq!(display.text, "\u{2022}".repeat(6));
    let selected = display.selection.clone().expect("the bullets are selected");
    assert_eq!(selected, 0..display.text.len());
    // Laid out, it is a wash over every bullet (one byte a bullet here).
    let shown = "******";
    let laid = Mono::new(shown, 40);
    assert_eq!(
        selection_rects(&laid, shown, 0..6, px(4.0)),
        vec![rect(0.0, 0.0, 60.0)]
    );
    // Part of it, from a ⇧-arrow: the bullets of the chars selected.
    field.select(2, 4);
    let display = field.display(true, true);
    let bullet = '\u{2022}'.len_utf8();
    assert_eq!(display.selection, Some(2 * bullet..4 * bullet));
}

/// `Mono` with its first paragraph drawn twice as tall (a heading, `runs.rs`).
struct Headed(Mono);

const TALL: f32 = 2.0 * LINE;

impl Laid for Headed {
    fn position(&self, index: usize) -> Option<Point<Pixels>> {
        let at = self.0.position(index)?;
        let below = if index > self.0.lines[0].1 { LINE } else { 0.0 };
        Some(point(at.x, at.y + px(below)))
    }

    fn hit(&self, position: Point<Pixels>) -> usize {
        let y = f32::from(position.y);
        let y = if y < TALL { y / 2.0 } else { y - LINE };
        self.0.hit(point(position.x, px(y)))
    }

    fn line_height(&self) -> Pixels {
        px(LINE)
    }

    fn line_height_at(&self, index: usize) -> Pixels {
        px(if index <= self.0.lines[0].1 {
            TALL
        } else {
            LINE
        })
    }

    fn bounds(&self) -> Bounds<Pixels> {
        let mut bounds = self.0.bounds();
        bounds.size.height += px(LINE);
        bounds
    }
}

#[test]
fn a_sized_line_draws_its_caret_and_selection_at_its_own_height() {
    let text = "# Hi\nyes";
    let laid = Headed(Mono::new(text, 40));
    assert_eq!(
        caret_bar(&laid, text, 2, px(1.0)).map(|bar| bar.size.height),
        Some(px(TALL))
    );
    assert_eq!(
        caret_bar(&laid, text, 6, px(1.0)).map(|bar| (bar.origin.y, bar.size.height)),
        Some((px(TALL), px(LINE)))
    );
    let rects = selection_rects(&laid, text, 2..7, px(5.0));
    assert_eq!(rects.len(), 2);
    assert_eq!(rects[0].size.height, px(TALL));
    assert_eq!(
        (rects[1].origin.y, rects[1].size.height),
        (px(TALL), px(LINE))
    );
}
