use gpui::{px, rgba, FontStyle, FontWeight, HighlightStyle, Hsla, Rgba, TextStyle};

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

/// The color a highlight leaves on text drawn in `base`, as GPUI draws it.
fn drawn(base: u32, look: HighlightStyle) -> Rgba {
    let text = TextStyle {
        color: Hsla::from(rgba(base)),
        ..TextStyle::default()
    };
    Rgba::from(text.highlight(look).color)
}

fn colored(start: usize, end: usize, color: &str) -> InputRun {
    InputRun {
        color: Some(color.to_owned()),
        ..run(start, end)
    }
}

#[test]
fn a_translucent_run_draws_faded_over_text_of_its_own_color() {
    let text = "# Plan";
    // A Markdown marker at the text's own ink, a third of it.
    let styled = style(
        &[colored(0, 2, "#1d1d1f55")],
        text,
        text,
        &bytes(text),
        None,
    );
    assert_eq!(styled.highlights.len(), 1);
    let ink = drawn(0x1d1d1fff, styled.highlights[0].1);
    assert!(
        (ink.a - 0x55 as f32 / 255.0).abs() < 0.01,
        "alpha {}",
        ink.a
    );
    assert!((ink.r - 0x1d as f32 / 255.0).abs() < 0.01);
    // In Dark, over light text, the same.
    let styled = style(
        &[colored(0, 2, "#f5f5f766")],
        text,
        text,
        &bytes(text),
        None,
    );
    let ink = drawn(0xf5f5f7ff, styled.highlights[0].1);
    assert!(
        (ink.a - 0x66 as f32 / 255.0).abs() < 0.01,
        "alpha {}",
        ink.a
    );
    // An opaque run is drawn at full ink, unfaded.
    let styled = style(&[colored(0, 2, "#3a6b35")], text, text, &bytes(text), None);
    assert_eq!(styled.highlights[0].1.fade_out, None);
    assert!((drawn(0x1d1d1fff, styled.highlights[0].1).a - 1.0).abs() < 0.001);
}

#[test]
fn an_opaque_run_over_a_translucent_one_drops_its_fade() {
    let text = "**b**";
    let styled = style(
        &[colored(0, 5, "#1d1d1f55"), colored(2, 3, "#1d1d1f")],
        text,
        text,
        &bytes(text),
        None,
    );
    assert_eq!(styled.highlights.len(), 3);
    assert!(styled.highlights[0].1.fade_out.is_some());
    assert_eq!(styled.highlights[1].1.fade_out, None);
    assert!((drawn(0x1d1d1fff, styled.highlights[1].1).a - 1.0).abs() < 0.001);
    // A layer without a color (a weight) keeps the fade under it.
    let styled = style(
        &[
            colored(0, 5, "#1d1d1f55"),
            InputRun {
                weight: Some(Weight::Bold),
                ..run(0, 5)
            },
        ],
        text,
        text,
        &bytes(text),
        None,
    );
    assert!(styled.highlights[0].1.fade_out.is_some());
}
