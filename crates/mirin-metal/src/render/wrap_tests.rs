//! Where GPUI breaks a wrapped text, on its test platform (every char one em
//! wide: 10 px at its size).

use gpui::{div, point, prelude::*, px, size, AvailableSpace, StyledText, TestAppContext};

const URL_NOTE: &str = "Read the plan at https://github.com/Netko-Labs/dashiOS/blob/release/0.8.0/docs/architecture.md#session-startup-and-the-systemd-user-target before the review.";

/// `text` as it is drawn in a box `chars` chars wide: its lines.
fn lines(cx: &mut TestAppContext, text: &'static str, chars: usize) -> Vec<String> {
    let text = StyledText::new(text);
    let layout = text.layout().clone();
    let width = px(chars as f32 * 10.0);
    let cx = cx.add_empty_window();
    cx.draw(
        point(px(0.0), px(0.0)),
        size(
            AvailableSpace::Definite(width),
            AvailableSpace::Definite(px(400.0)),
        ),
        move |_, _| div().w(width).child(text),
    );
    layout.wrapped_text().lines().map(str::to_owned).collect()
}

#[gpui::test]
fn a_long_url_breaks_after_a_slash_or_a_hyphen_where_the_line_is_full(cx: &mut TestAppContext) {
    // Before, a line broke before a slash and never at a hyphen: a narrow note had
    // "https:/", "/github.com/Netko-Labs/dashiOS", "/blob/release/0.8.0/docs", …, a line a segment.
    assert_eq!(
        lines(cx, URL_NOTE, 30),
        [
            "Read the plan at https://",
            "github.com/Netko-Labs/dashiOS/",
            "blob/release/0.8.0/docs/",
            "architecture.md#session-",
            "startup-and-the-systemd-user-",
            "target before the review.",
        ]
    );
}

#[gpui::test]
fn a_url_in_a_wide_line_breaks_once_at_the_last_slash_that_fits(cx: &mut TestAppContext) {
    assert_eq!(
        lines(cx, URL_NOTE, 62),
        [
            "Read the plan at https://github.com/Netko-Labs/dashiOS/blob/",
            "release/0.8.0/docs/architecture.md#session-startup-and-the-",
            "systemd-user-target before the review.",
        ]
    );
}

#[gpui::test]
fn a_url_that_fits_on_the_next_line_moves_there_whole(cx: &mut TestAppContext) {
    // As a browser does: it breaks at the space before the URL, not at a slash inside it.
    assert_eq!(
        lines(cx, "Short one: dashi.dev/docs", 16),
        ["Short one: ", "dashi.dev/docs"]
    );
}

// The fork's own rule (`LineWrapper::breaks_inside_word`); upstream GPUI breaks
// by UAX #14 instead (docs/metal/gpui-next.md).
#[cfg(not(feature = "gpui-next"))]
#[test]
fn a_word_breaks_inside_only_after_a_slash_or_a_hyphen_between_letters() {
    use gpui::LineWrapper;

    let breaks = |text: &str| -> Vec<usize> {
        let chars: Vec<char> = text.chars().collect();
        (2..chars.len())
            .filter(|&at| LineWrapper::breaks_inside_word(chars[at - 2], chars[at - 1], chars[at]))
            .collect()
    };
    assert_eq!(breaks("dashi.dev/docs/guide"), [10, 15]);
    assert_eq!(breaks("https://dashi.dev"), [8]);
    assert_eq!(breaks("well-known"), [5]);
    // A path's first slash, a date, a fraction, a flag, a negative number: whole.
    assert_eq!(breaks("/usr/bin"), [5]);
    assert_eq!(breaks("11/11/2026"), Vec::<usize>::new());
    assert_eq!(breaks("2026-11-11"), Vec::<usize>::new());
    assert_eq!(breaks("--flag x-1"), Vec::<usize>::new());
    assert_eq!(breaks("and/or"), [4]);
}
