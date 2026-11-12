//! The caret and the selection: keys, the pointer, Cut and Copy, what is
//! drawn, and the driver's offsets.

use super::super::words::{paragraph_at, word_at, word_end_after, word_start_before};
use super::super::{Edit, Field};
use super::{ctrl, key, press, press_in, shift, with, Board, Rows};
use gpui::Modifiers;

fn chars(text: &str) -> Vec<char> {
    text.chars().collect()
}

fn alt(name: &str) -> gpui::Keystroke {
    let modifiers = Modifiers {
        alt: true,
        ..Modifiers::default()
    };
    with(modifiers, name)
}

fn ctrl_shift(name: &str) -> gpui::Keystroke {
    let modifiers = Modifiers {
        control: true,
        shift: true,
        ..Modifiers::default()
    };
    with(modifiers, name)
}

#[test]
fn words_stop_where_a_mac_stops() {
    let text = chars("one, two  three");
    assert_eq!(word_end_after(&text, 0), 3);
    assert_eq!(word_end_after(&text, 3), 8);
    assert_eq!(word_end_after(&text, 8), 15);
    assert_eq!(word_start_before(&text, 15), 10);
    assert_eq!(word_start_before(&text, 10), 5);
    assert_eq!(word_start_before(&text, 6), 5);
    assert_eq!(word_start_before(&text, 5), 0);
    assert_eq!(word_start_before(&text, 0), 0);
}

#[test]
fn a_double_click_takes_the_run_under_it() {
    let text = chars("say hi,  there\n\nend");
    assert_eq!(word_at(&text, 5), 4..6);
    assert_eq!(word_at(&text, 6), 6..7);
    assert_eq!(word_at(&text, 8), 7..9);
    // At a line's end, the word before it; on an empty line, nothing.
    assert_eq!(word_at(&text, 14), 9..14);
    assert_eq!(word_at(&text, 15), 15..15);
    assert_eq!(word_at(&text, 19), 16..19);
}

#[test]
fn a_paragraph_runs_between_line_breaks() {
    let text = chars("ab\ncd\n\nef");
    assert_eq!(paragraph_at(&text, 0), 0..2);
    assert_eq!(paragraph_at(&text, 2), 0..2);
    assert_eq!(paragraph_at(&text, 4), 3..5);
    assert_eq!(paragraph_at(&text, 6), 6..6);
    assert_eq!(paragraph_at(&text, 9), 7..9);
}

#[test]
fn shift_arrows_extend_and_plain_arrows_collapse() {
    let mut field = Field::new("hello");
    field.place(1);
    assert_eq!(press(&mut field, &shift("right"), false), Edit::Moved);
    assert_eq!(press(&mut field, &shift("right"), false), Edit::Moved);
    assert_eq!(field.selection(), 1..3);
    assert_eq!(field.selected_text(), "el");
    // Back past where it began: the other way from the anchor.
    for _ in 0..3 {
        press(&mut field, &shift("left"), false);
    }
    assert_eq!(field.selection(), 0..1);
    assert!(field.is_reversed());
    // ← lands at the selection's start, → at its end.
    press(&mut field, &key("right", None), false);
    assert_eq!((field.cursor, field.has_selection()), (1, false));
    field.select(1, 4);
    press(&mut field, &key("left", None), false);
    assert_eq!((field.cursor, field.has_selection()), (1, false));
}

#[test]
fn word_and_line_moves_follow_dashis_keys() {
    // ⌥← reaches the field as Ctrl+← (Dashi's keymap), or as Alt itself.
    let mut field = Field::new("one two three");
    press(&mut field, &ctrl("left"), false);
    assert_eq!(field.cursor, 8);
    press(&mut field, &alt("left"), false);
    assert_eq!(field.cursor, 4);
    press(&mut field, &ctrl_shift("right"), false);
    assert_eq!(field.selected_text(), "two");
    // ❖← and ❖→ arrive as Home and End; ❖↑ and ❖↓ as Ctrl+Home and Ctrl+End.
    press(&mut field, &shift("home"), false);
    assert_eq!(field.selected_text(), "one ");
    press(&mut field, &key("end", None), false);
    assert_eq!((field.cursor, field.has_selection()), (13, false));
    let mut lines = Field::new("ab\ncd\nef");
    lines.place(4);
    press(&mut lines, &key("home", None), true);
    assert_eq!(lines.cursor, 3);
    press(&mut lines, &shift("end"), true);
    assert_eq!(lines.selected_text(), "cd");
    press(&mut lines, &ctrl_shift("end"), true);
    assert_eq!(lines.selected_text(), "cd\nef");
    press(&mut lines, &ctrl("home"), true);
    assert_eq!(lines.cursor, 0);
}

#[test]
fn up_and_down_move_by_drawn_line_and_keep_their_x() {
    // Drawn 4 wide: "abcd", "efgh", "ij".
    let mut field = Field::new("abcdefghij");
    let rows = Rows { width: 4, len: 10 };
    let mut board = Board::default();
    field.place(3);
    press_in(
        &mut field,
        &key("down", None),
        true,
        &mut board,
        Some(&rows),
    );
    assert_eq!(field.cursor, 7);
    press_in(
        &mut field,
        &key("down", None),
        true,
        &mut board,
        Some(&rows),
    );
    // The last row is short: the end of it, and the x is kept for the way back.
    assert_eq!(field.cursor, 10);
    press_in(&mut field, &key("up", None), true, &mut board, Some(&rows));
    assert_eq!(field.cursor, 7);
    press_in(&mut field, &shift("up"), true, &mut board, Some(&rows));
    assert_eq!(field.selection(), 3..7);
    // Past the first line is the start.
    press_in(&mut field, &key("up", None), true, &mut board, Some(&rows));
    assert_eq!(field.cursor, 0);
    // Home and End are the drawn line's.
    field.place(5);
    press_in(&mut field, &key("end", None), true, &mut board, Some(&rows));
    assert_eq!(field.cursor, 8);
}

#[test]
fn without_a_layout_up_and_down_go_by_paragraph() {
    let mut field = Field::new("abc\nde\nfghi");
    field.place(2);
    press(&mut field, &key("down", None), true);
    assert_eq!(field.cursor, 6);
    press(&mut field, &key("down", None), true);
    assert_eq!(field.cursor, 9);
    press(&mut field, &key("down", None), true);
    assert_eq!(field.cursor, 11);
}

#[test]
fn a_single_line_reports_up_and_down_but_extends_with_shift() {
    let mut field = Field::new("abc");
    field.place(1);
    assert_eq!(
        press(&mut field, &key("up", None), false),
        Edit::Key("ArrowUp")
    );
    assert_eq!(field.cursor, 1);
    assert_eq!(press(&mut field, &shift("down"), false), Edit::Moved);
    assert_eq!(field.selected_text(), "bc");
}

#[test]
fn deleting_takes_the_selection_or_a_word() {
    let mut field = Field::new("one two three");
    field.select(4, 8);
    assert_eq!(
        press(&mut field, &key("delete", None), false),
        Edit::Changed
    );
    assert_eq!(field.buffer, "one three");
    // ⌥⌫ reaches the field as Ctrl+Backspace.
    field.place(9);
    press(&mut field, &ctrl("backspace"), false);
    assert_eq!(field.buffer, "one ");
    // ❖⌫ is ⇧Home then Backspace: to the line's start.
    let mut lines = Field::new("ab\ncd ef");
    lines.place(5);
    press(&mut lines, &shift("home"), true);
    press(&mut lines, &key("backspace", None), true);
    assert_eq!(lines.buffer, "ab\n ef");
}

#[test]
fn cut_copy_and_paste_act_on_the_selection() {
    let mut board = Board::default();
    let mut field = Field::new("hello world");
    field.select(6, 11);
    let edit = press_in(&mut field, &ctrl("c"), false, &mut board, None);
    assert_eq!((edit, board.0.as_deref()), (Edit::Handled, Some("world")));
    assert_eq!(field.buffer, "hello world");
    field.select(0, 5);
    let edit = press_in(&mut field, &ctrl("x"), false, &mut board, None);
    assert_eq!((edit, field.buffer.as_str()), (Edit::Changed, " world"));
    field.select(1, 6);
    press_in(&mut field, &ctrl("v"), false, &mut board, None);
    assert_eq!(field.buffer, " hello");
    // Super (❖) chords a compositor passes through do the same.
    let platform = Modifiers {
        platform: true,
        ..Modifiers::default()
    };
    field.select_all();
    press_in(&mut field, &with(platform, "c"), false, &mut board, None);
    assert_eq!(board.0.as_deref(), Some(" hello"));
}

#[test]
fn a_secure_field_never_gives_its_text_away() {
    let mut board = Board::default();
    let mut field = Field::new("secret");
    field.select_all();
    let mut env = super::super::KeyEnv {
        multiline: false,
        submit_on_enter: false,
        insert_tab: false,
        secure: true,
        clipboard: &mut board,
        lines: None,
    };
    assert_eq!(field.key(&ctrl("c"), &mut env), Edit::None);
    assert_eq!(field.key(&ctrl("x"), &mut env), Edit::None);
    assert_eq!(field.buffer, "secret");
    assert_eq!(board.0, None);
}

#[test]
fn the_selection_is_drawn_beside_the_caret() {
    let mut field = Field::new("abcd");
    field.select(1, 3);
    let display = field.display(true, false);
    assert_eq!((display.text.as_str(), display.caret), ("abcd", Some(3)));
    assert_eq!(&display.text[display.selection.clone().unwrap()], "bc");
    // Selected backwards, the caret is before it.
    field.select(3, 1);
    let display = field.display(true, false);
    assert_eq!((display.text.as_str(), display.caret), ("abcd", Some(1)));
    assert_eq!(&display.text[display.selection.clone().unwrap()], "bc");
    // Unfocused, nothing is drawn as selected.
    assert_eq!(field.display(false, false).selection, None);
}

#[test]
fn drawn_bytes_map_back_to_the_text() {
    let mut field = Field::new("aé😀b");
    field.place(2);
    field.compose("xy");
    let display = field.display(true, false);
    // The composition is the cursor.
    for byte in 0..display.text.len() {
        let index = display.buffer_char(byte);
        assert!(index <= 4, "{byte} → {index}");
    }
    assert_eq!(display.buffer_char(0), 0);
    assert_eq!(display.buffer_char(1), 1);
    assert_eq!(
        display.buffer_char(display.composition.clone().unwrap().start + 1),
        2
    );
    assert_eq!(display.buffer_char(display.text.len()), 4);
    assert_eq!(display.byte_of(3), display.text.len() - 1);
    assert_eq!(display.byte_of(1), 1);
}

#[test]
fn clicks_place_select_words_and_lines() {
    let mut field = Field::new("one two\nthree");
    let (_, changed) = field.press(5, 1, false, true);
    assert!(!changed);
    assert_eq!((field.cursor, field.has_selection()), (5, false));
    field.press(5, 2, false, true);
    assert_eq!(field.selected_text(), "two");
    field.press(10, 3, false, true);
    assert_eq!(field.selected_text(), "three");
    // A single-line field's triple click is all of it.
    let mut line = Field::new("a b");
    line.press(0, 3, false, false);
    assert_eq!(line.selection(), 0..3);
}

#[test]
fn shift_click_extends_and_drags_grow_by_the_press_unit() {
    let mut field = Field::new("one two three");
    field.place(2);
    field.press(9, 1, true, false);
    assert_eq!(field.selection(), 2..9);
    // A drag from a click selects characters, either way.
    let (press, _) = field.press(5, 1, false, false);
    field.drag(&press, 9, false);
    assert_eq!(field.selection(), 5..9);
    field.drag(&press, 1, false);
    assert_eq!((field.selection(), field.cursor), (1..5, 1));
    // From a double click, whole words.
    let (press, _) = field.press(5, 2, false, false);
    field.drag(&press, 9, false);
    assert_eq!(field.selected_text(), "two three");
    field.drag(&press, 1, false);
    assert_eq!(field.selected_text(), "one two");
}

#[test]
fn a_click_while_composing_keeps_the_composition_where_it_shows() {
    let mut field = Field::new("ab");
    field.place(1);
    field.compose("xy");
    // Char 2 ("b") is after the composition; it becomes char 4.
    let (_, changed) = field.press(2, 1, false, false);
    assert!(changed);
    assert_eq!((field.buffer.as_str(), field.cursor), ("axyb", 4));
}

#[test]
fn the_driver_reads_and_sets_the_selection_in_utf16() {
    let mut field = Field::new("😀ab");
    field.select(1, 3);
    assert_eq!(field.selection_utf16(), (2, 4));
    field.set_selection_utf16(4, 2);
    assert_eq!((field.selection(), field.cursor), (1..3, 1));
    // Out of range, clamped; inside a character, its start.
    field.set_selection_utf16(1, 99);
    assert_eq!(field.selection(), 0..3);
}
