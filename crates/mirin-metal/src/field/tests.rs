use std::ops::Range;

use super::{Clipboard, Display, Edit, Field, KeyEnv, Lines, Vertical};
use gpui::{Keystroke, Modifiers};

mod selection;

/// A key as GPUI reports it on Linux: its name and the text it types.
pub(super) fn key(name: &str, text: Option<&str>) -> Keystroke {
    Keystroke {
        modifiers: Modifiers::default(),
        key: name.to_owned(),
        key_char: text.map(str::to_owned),
    }
}

pub(super) fn with(modifiers: Modifiers, name: &str) -> Keystroke {
    Keystroke {
        modifiers,
        key: name.to_owned(),
        key_char: None,
    }
}

pub(super) fn ctrl(name: &str) -> Keystroke {
    let modifiers = Modifiers {
        control: true,
        ..Modifiers::default()
    };
    with(modifiers, name)
}

pub(super) fn shift(name: &str) -> Keystroke {
    let modifiers = Modifiers {
        shift: true,
        ..Modifiers::default()
    };
    with(modifiers, name)
}

/// A clipboard in memory.
#[derive(Default)]
pub(super) struct Board(pub(super) Option<String>);

impl Clipboard for Board {
    fn read(&mut self) -> Option<String> {
        self.0.clone()
    }

    fn write(&mut self, text: &str) {
        self.0 = Some(text.to_owned());
    }
}

/// Lines drawn `width` chars wide, every char one pixel: a stand-in for a
/// laid-out text.
pub(super) struct Rows {
    pub(super) width: usize,
    pub(super) len: usize,
}

impl Lines for Rows {
    fn line(&self, index: usize) -> Option<Range<usize>> {
        let start = index.min(self.len.saturating_sub(1)) / self.width * self.width;
        Some(start..(start + self.width).min(self.len))
    }

    fn x_of(&self, index: usize) -> Option<f32> {
        Some((index % self.width) as f32)
    }

    fn vertical(&self, index: usize, step: isize, x: f32) -> Option<Vertical> {
        let row = (index / self.width) as isize + step;
        if row < 0 || row as usize * self.width > self.len {
            return Some(Vertical::Past);
        }
        let start = row as usize * self.width;
        Some(Vertical::To((start + x as usize).min(self.len)))
    }
}

/// Press `keystroke` in a field, with a clipboard and (maybe) drawn lines.
pub(super) fn press_in(
    field: &mut Field,
    keystroke: &Keystroke,
    multiline: bool,
    board: &mut Board,
    lines: Option<&dyn Lines>,
) -> Edit {
    let mut env = KeyEnv {
        multiline,
        secure: false,
        clipboard: board,
        lines,
    };
    field.key(keystroke, &mut env)
}

pub(super) fn press(field: &mut Field, keystroke: &Keystroke, multiline: bool) -> Edit {
    press_in(field, keystroke, multiline, &mut Board::default(), None)
}

fn type_keys(field: &mut Field, text: &str) {
    for ch in text.chars() {
        let name = ch.to_string();
        let edit = press(field, &key(&name, Some(&name)), false);
        assert_eq!(edit, Edit::Changed);
    }
}

fn shown(field: &Field) -> String {
    field.display(true, false).text
}

#[test]
fn plain_typing_inserts_at_the_caret() {
    let mut field = Field::new("");
    type_keys(&mut field, "hllo");
    field.cursor = 1;
    type_keys(&mut field, "e");
    assert_eq!(field.buffer, "hello");
    assert_eq!(field.cursor, 2);
    assert_eq!(press(&mut field, &key("space", None), false), Edit::Changed);
    assert_eq!(field.buffer, "he llo");
    assert_eq!(
        press(&mut field, &key("backspace", None), false),
        Edit::Changed
    );
    assert_eq!(field.buffer, "hello");
    // Nothing before the caret: nothing to erase, and nothing reported.
    field.cursor = 0;
    assert_eq!(
        press(&mut field, &key("backspace", None), false),
        Edit::None
    );
}

#[test]
fn keys_that_type_nothing_change_nothing() {
    let mut field = Field::new("abc");
    assert_eq!(press(&mut field, &key("f5", None), false), Edit::None);
    // Cut and Copy with nothing selected.
    assert_eq!(press(&mut field, &ctrl("x"), false), Edit::None);
    assert_eq!(press(&mut field, &ctrl("c"), false), Edit::None);
    assert_eq!(field.buffer, "abc");
}

#[test]
fn enter_submits_a_line_and_breaks_a_multiline_field() {
    let mut field = Field::new("a");
    assert_eq!(
        press(&mut field, &key("enter", None), false),
        Edit::Submitted
    );
    assert_eq!(press(&mut field, &key("enter", None), true), Edit::Changed);
    assert_eq!(field.buffer, "a\n");
    assert_eq!(press(&mut field, &ctrl("enter"), true), Edit::Submitted);
}

#[test]
fn select_all_then_typing_replaces_everything() {
    let mut field = Field::new("old");
    assert_eq!(press(&mut field, &ctrl("a"), false), Edit::Moved);
    assert_eq!(field.selection(), 0..3);
    type_keys(&mut field, "n");
    assert_eq!(field.buffer, "n");
    assert!(!field.has_selection());
}

#[test]
fn paste_keeps_a_line_on_one_line() {
    let mut field = Field::new("");
    let mut board = Board(Some("a\nb".to_owned()));
    let edit = press_in(&mut field, &ctrl("v"), false, &mut board, None);
    assert_eq!(edit, Edit::Changed);
    assert_eq!(field.buffer, "a b");
}

#[test]
fn a_composition_shows_underlined_at_the_caret_and_is_not_the_text() {
    let mut field = Field::new("ab");
    field.cursor = 1;
    assert!(!field.compose("ni hao"));
    assert_eq!(field.buffer, "ab");
    let Display {
        text,
        composition,
        caret,
        ..
    } = field.display(true, false);
    assert_eq!(text, "ani haob");
    assert_eq!(composition, Some(1..7));
    assert_eq!(caret, Some(7));
    // Unfocused or secure, it is not drawn.
    assert_eq!(field.display(false, false).text, "ab");
    assert_eq!(field.display(true, true).composition, None);
}

#[test]
fn committing_inserts_at_the_caret_and_ends_the_composition() {
    let mut field = Field::new("ab");
    field.cursor = 1;
    field.compose("nihao");
    assert!(field.commit("你好", false));
    assert_eq!(field.buffer, "a你好b");
    assert_eq!(field.cursor, 3);
    assert_eq!(field.preedit, None);
    assert_eq!(shown(&field), "a你好b");
}

#[test]
fn the_input_method_taking_its_composition_back_leaves_the_text() {
    let mut field = Field::new("ab");
    field.compose("n");
    assert!(!field.compose(""));
    assert_eq!(field.preedit, None);
    // GPUI's DeleteText: the marked range replaced by nothing.
    field.compose("ni");
    let marked = field.marked_utf16();
    assert_eq!(marked, Some(2..4));
    assert!(!field.replace_utf16(marked, "", false));
    assert_eq!(
        (field.buffer.as_str(), field.preedit.as_deref()),
        ("ab", None)
    );
}

#[test]
fn the_document_has_the_composition_in_it_in_utf16() {
    // "😀" is two UTF-16 units; "é" one.
    let mut field = Field::new("😀é");
    field.cursor = 1;
    field.compose("ka");
    assert_eq!(field.marked_utf16(), Some(2..4));
    assert_eq!(field.selected_utf16(), 4..4);
    assert_eq!(field.text_for_utf16(0..5), "😀kaé");
    assert_eq!(field.text_for_utf16(2..4), "ka");
}

#[test]
fn replacing_another_range_edits_the_text() {
    let mut field = Field::new("hello world");
    assert!(field.replace_utf16(Some(0..5), "howdy", false));
    assert_eq!(field.buffer, "howdy world");
    assert_eq!(field.cursor, 5);
}

#[test]
fn a_composition_over_a_selection_replaces_it() {
    let mut field = Field::new("old");
    press(&mut field, &ctrl("a"), false);
    assert!(field.compose("n"));
    assert_eq!(field.buffer, "");
    assert!(field.commit("你", false));
    assert_eq!(field.buffer, "你");
    // Over part of the text, only that part goes.
    let mut field = Field::new("one two");
    field.select(4, 7);
    assert_eq!(field.selected_utf16(), 4..7);
    assert!(field.compose("x"));
    assert_eq!(field.buffer, "one ");
    assert_eq!(field.selected_utf16(), 5..5);
}

#[test]
fn a_key_that_edits_ends_a_dead_key_composition() {
    // A dead key composes "´"; the next key types the composed "é".
    let mut field = Field::new("");
    field.compose("´");
    assert_eq!(
        press(&mut field, &key("dead_acute", None), false),
        Edit::None
    );
    assert_eq!(field.preedit.as_deref(), Some("´"));
    type_keys(&mut field, "é");
    assert_eq!(
        (field.buffer.as_str(), field.preedit.as_deref()),
        ("é", None)
    );
}

#[test]
fn unmarking_keeps_the_composition_as_text() {
    let mut field = Field::new("a");
    field.compose("ni");
    assert!(field.unmark(false));
    assert_eq!(field.buffer, "ani");
    assert!(!field.unmark(false));
}

#[test]
fn committed_text_is_cleaned_for_the_field() {
    let mut field = Field::new("");
    field.commit("a\nb\u{7}", false);
    assert_eq!(field.buffer, "a b");
    let mut lines = Field::new("");
    lines.commit("a\nb", true);
    assert_eq!(lines.buffer, "a\nb");
}

#[test]
fn document_offsets_map_into_the_drawn_text() {
    let mut field = Field::new("ab");
    field.cursor = 1;
    // No composition: the drawn text is the text.
    assert_eq!(field.display_byte(1), 1);
    assert_eq!(field.display_byte(2), 2);
    field.compose("xy");
    let shown = shown(&field);
    // The composition starts at the cursor; the caret is at its end.
    assert_eq!(field.display_byte(1), 1);
    assert_eq!(&shown[field.display_byte(3)..], "b");
    assert_eq!(
        field.display(true, false).caret,
        Some(field.display_byte(3))
    );
    assert_eq!(field.display_byte(4), shown.len());
}

#[test]
fn a_reset_keeps_the_composition_and_drops_the_selection() {
    let mut field = Field::new("abc");
    field.select(0, 2);
    field.compose("n");
    field.reset("");
    assert_eq!(field.cursor, 0);
    assert!(!field.has_selection());
    assert_eq!(field.preedit.as_deref(), Some("n"));
}
