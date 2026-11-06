use super::{Display, Edit, Field, CARET};
use gpui::{Keystroke, Modifiers};

/// A key as GPUI reports it on Linux: its name and the text it types.
fn key(name: &str, text: Option<&str>) -> Keystroke {
    Keystroke {
        modifiers: Modifiers::default(),
        key: name.to_owned(),
        key_char: text.map(str::to_owned),
    }
}

fn ctrl(name: &str) -> Keystroke {
    Keystroke {
        modifiers: Modifiers {
            control: true,
            ..Modifiers::default()
        },
        key: name.to_owned(),
        key_char: None,
    }
}

fn type_keys(field: &mut Field, text: &str) {
    for ch in text.chars() {
        let name = ch.to_string();
        let edit = field.key(&key(&name, Some(&name)), false, || None);
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
    assert_eq!(
        field.key(&key("space", None), false, || None),
        Edit::Changed
    );
    assert_eq!(field.buffer, "he llo");
    assert_eq!(
        field.key(&key("backspace", None), false, || None),
        Edit::Changed
    );
    assert_eq!(field.buffer, "hello");
    // Nothing before the caret: nothing to erase, and nothing reported.
    field.cursor = 0;
    assert_eq!(
        field.key(&key("backspace", None), false, || None),
        Edit::None
    );
}

#[test]
fn keys_that_type_nothing_change_nothing() {
    let mut field = Field::new("abc");
    assert_eq!(field.key(&key("f5", None), false, || None), Edit::None);
    assert_eq!(field.key(&ctrl("x"), false, || None), Edit::None);
    assert_eq!(field.buffer, "abc");
}

#[test]
fn enter_submits_a_line_and_breaks_a_multiline_field() {
    let mut field = Field::new("a");
    assert_eq!(
        field.key(&key("enter", None), false, || None),
        Edit::Submitted
    );
    assert_eq!(field.key(&key("enter", None), true, || None), Edit::Changed);
    assert_eq!(field.buffer, "a\n");
    assert_eq!(field.key(&ctrl("enter"), true, || None), Edit::Submitted);
}

#[test]
fn select_all_then_typing_replaces_everything() {
    let mut field = Field::new("old");
    assert_eq!(field.key(&ctrl("a"), false, || None), Edit::Changed);
    type_keys(&mut field, "n");
    assert_eq!(field.buffer, "n");
    assert!(!field.select_all);
}

#[test]
fn paste_keeps_a_line_on_one_line() {
    let mut field = Field::new("");
    let edit = field.key(&ctrl("v"), false, || Some("a\nb".to_owned()));
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
    } = field.display(true, false);
    assert_eq!(text, format!("ani hao{CARET}b"));
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
    assert_eq!(shown(&field), format!("a你好{CARET}b"));
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
fn a_composition_over_select_all_replaces_the_text() {
    let mut field = Field::new("old");
    field.key(&ctrl("a"), false, || None);
    assert!(field.compose("n"));
    assert_eq!(field.buffer, "");
    assert!(field.commit("你", false));
    assert_eq!(field.buffer, "你");
}

#[test]
fn a_key_that_edits_ends_a_dead_key_composition() {
    // A dead key composes "´"; the next key types the composed "é".
    let mut field = Field::new("");
    field.compose("´");
    assert_eq!(
        field.key(&key("dead_acute", None), false, || None),
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
    // No composition: the caret glyph is at the cursor; after it, past the glyph.
    assert_eq!(field.display_byte(1), 1);
    assert_eq!(field.display_byte(2), 1 + CARET.len() + 1);
    field.compose("xy");
    let shown = shown(&field);
    // The composition starts at the cursor; its end is the caret glyph.
    assert_eq!(field.display_byte(1), 1);
    assert_eq!(&shown[field.display_byte(3)..], format!("{CARET}b"));
    assert_eq!(field.display_byte(4), shown.len());
}

#[test]
fn a_reset_keeps_the_composition() {
    let mut field = Field::new("abc");
    field.compose("n");
    field.reset("");
    assert_eq!(field.cursor, 0);
    assert_eq!(field.preedit.as_deref(), Some("n"));
}
