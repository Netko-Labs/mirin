use gpui::{px, FontStyle, FontWeight, HighlightStyle};

use super::{flatten, pressed, style, Units};
use crate::tree::{InputRun, Weight};

fn run(start: usize, end: usize) -> InputRun {
    InputRun {
        start,
        end,
        ..InputRun::default()
    }
}

fn bytes(text: &str) -> Vec<usize> {
    text.char_indices()
        .map(|(byte, _)| byte)
        .chain(std::iter::once(text.len()))
        .collect()
}

#[test]
fn utf16_offsets_map_to_chars() {
    let units = Units::new("a😀b");
    assert_eq!(units.char_at(0), 0);
    assert_eq!(units.char_at(1), 1);
    // Inside the surrogate pair: the emoji itself.
    assert_eq!(units.char_at(2), 1);
    assert_eq!(units.char_at(3), 2);
    assert_eq!(units.char_at(99), 3);
    assert_eq!(units.offset_of(2), 3);
}

#[test]
fn overlapping_layers_flatten_in_order() {
    let bold = HighlightStyle {
        font_weight: Some(FontWeight::BOLD),
        ..HighlightStyle::default()
    };
    let italic = HighlightStyle {
        font_style: Some(FontStyle::Italic),
        ..HighlightStyle::default()
    };
    let flat = flatten(&[(0..6, bold), (3..9, italic)]);
    assert_eq!(flat.len(), 3);
    assert_eq!(flat[0], (0..3, bold));
    assert_eq!(
        flat[1],
        (
            3..6,
            HighlightStyle {
                font_weight: Some(FontWeight::BOLD),
                font_style: Some(FontStyle::Italic),
                ..HighlightStyle::default()
            }
        )
    );
    assert_eq!(flat[2], (6..9, italic));
    // Touching pieces that look the same are one.
    assert_eq!(flatten(&[(0..2, bold), (2..4, bold)]), vec![(0..4, bold)]);
    assert!(flatten(&[]).is_empty());
}

#[test]
fn runs_become_byte_ranges_of_the_drawn_text() {
    let buffer = "é **b**";
    let styled = style(
        &[InputRun {
            weight: Some(Weight::Bold),
            ..run(2, 7)
        }],
        buffer,
        buffer,
        &bytes(buffer),
        None,
    );
    // "é" is two bytes: char 2 starts at byte 3.
    assert_eq!(styled.highlights.len(), 1);
    assert_eq!(styled.highlights[0].0, 3..8);
    assert!(styled.sizes.is_empty());
}

#[test]
fn a_sized_run_sizes_its_paragraphs() {
    let text = "# Title\nbody\n\nmore";
    let styled = style(
        &[
            InputRun {
                size: Some(20.0),
                ..run(0, 7)
            },
            InputRun {
                size: Some(500.0),
                ..run(13, 13)
            },
        ],
        text,
        text,
        &bytes(text),
        None,
    );
    assert_eq!(
        styled.sizes,
        vec![Some(px(20.0)), None, Some(px(200.0)), None]
    );
    // A run with only a size draws nothing else.
    assert!(styled.highlights.is_empty());
}

#[test]
fn the_last_pressable_run_takes_a_press() {
    let runs = [
        InputRun {
            press: true,
            ..run(0, 5)
        },
        run(2, 4),
        InputRun {
            press: true,
            ..run(3, 4)
        },
    ];
    assert_eq!(pressed(&runs, "- [ ] milk", 1), Some(0));
    assert_eq!(pressed(&runs, "- [ ] milk", 3), Some(2));
    assert_eq!(pressed(&runs, "- [ ] milk", 5), None);
}
