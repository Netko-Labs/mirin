//! A field's text as a screen reader or an agent reads it (AT-SPI `Text`:
//! the words, the caret, the selection, the character count), and where
//! what they ask of it goes (`EditableText`: a whole value, a replaced
//! selection, a selection set in the field's runs).

use accesskit::{Action, ActionData, NodeId, Role, TextPosition, TextSelection};

use super::screen::{HeardText, Screen};
use crate::access::tree::{node_id, Request};

const FORM: &str = r##"{"type":"view","props":{"id":"1"},"children":[
    {"type":"input","props":{"id":"sum","value":"492","access":{"label":"Sum"}}},
    {"type":"input","props":{"id":"note","value":"buy milk\nand eggs","multiline":true}},
    {"type":"input","props":{"id":"search","value":"","placeholder":"Search","access":{"role":"search"}}},
    {"type":"input","props":{"id":"pw","value":"secret","secure":true,"placeholder":"Password"}}
]}"##;

fn heard(text: &str, caret: Option<usize>) -> HeardText {
    let count = text.chars().count();
    HeardText {
        text: text.to_owned(),
        count,
        caret,
        selection: caret.map(|caret| (caret, caret)),
    }
}

#[test]
fn every_field_reads_its_text() {
    let mut screen = Screen::new(FORM);
    screen.update();
    assert_eq!(screen.text(node_id("sum")), Some(heard("492", None)));
    assert_eq!(
        screen.text(node_id("note")),
        Some(heard("buy milk\nand eggs", None)),
        "a multiline field's lines, with their break"
    );
    assert_eq!(screen.text(node_id("search")), Some(heard("", None)));
    // A role that is not a field's (the search role) is still a field's
    // text: an empty field has a place for the caret.
    assert_eq!(
        screen.heard(node_id("search")).unwrap().role(),
        Role::SearchInput
    );
}

#[test]
fn a_password_says_how_long_it_is_and_never_what_it_is() {
    let mut screen = Screen::new(FORM);
    screen.update();
    let text = screen.text(node_id("pw")).unwrap();
    assert_eq!(text.count, 6, "filled, and how much");
    assert!(!text.text.contains("secret"));
    assert_eq!(text.text, "\u{2022}".repeat(6));
    // Typed into: still only its length.
    screen.focus(Some("pw"), Some("secret!"));
    screen.update();
    let text = screen.text(node_id("pw")).unwrap();
    assert_eq!((text.count, text.caret), (7, Some(7)));
    assert!(text.text.chars().all(|ch| ch == '\u{2022}'));
}

#[test]
fn the_focused_field_reads_what_is_typed_and_where_the_caret_is() {
    let mut screen = Screen::new(FORM);
    screen.update();
    screen.focus(Some("note"), Some("buy milk\nand eggs"));
    screen.select(9, 9);
    screen.update();
    assert_eq!(
        screen.text(node_id("note")),
        Some(heard("buy milk\nand eggs", Some(9))),
        "the caret at the second line's start"
    );
    // Dictation reads the words before the caret.
    let text = screen.text(node_id("note")).unwrap();
    let before: String = text.text.chars().take(text.caret.unwrap()).collect();
    assert_eq!(before, "buy milk\n");

    // Typing: the renderer's buffer, not the driver's lagging value.
    screen.focus(Some("note"), Some("buy milk\nand eggs, bread"));
    let took = screen.update();
    assert_eq!(
        screen.text(node_id("note")),
        Some(heard("buy milk\nand eggs, bread", Some(24)))
    );
    // The field and its second line alone: the first line is as it was.
    assert_eq!(took.sent, 2);

    // A selection, made backwards: the caret is where it moved to.
    screen.select(13, 9);
    let took = screen.update();
    let text = screen.text(node_id("note")).unwrap();
    assert_eq!((text.caret, text.selection), (Some(9), Some((9, 13))));
    assert_eq!(took.sent, 1, "only the field: its runs are as they were");

    // The keyboard leaves: the driver's value again, and no caret.
    screen.focus(None, None);
    screen.update();
    assert_eq!(
        screen.text(node_id("note")),
        Some(heard("buy milk\nand eggs", None))
    );
}

#[test]
fn lines_come_and_go_with_the_text() {
    let mut screen = Screen::new(FORM);
    screen.update();
    screen.focus(Some("note"), Some("one\ntwo\nthree\n"));
    screen.update();
    assert_eq!(
        screen.text(node_id("note")),
        Some(heard("one\ntwo\nthree\n", Some(14)))
    );
    let children = screen.heard(node_id("note")).unwrap().children().len();
    assert_eq!(children, 4, "three lines and the empty one after the break");
    screen.focus(Some("note"), Some("one"));
    screen.update();
    assert_eq!(screen.text(node_id("note")), Some(heard("one", Some(3))));
    assert_eq!(screen.heard(node_id("note")).unwrap().children().len(), 1);
}

#[test]
fn the_driver_writing_a_field_is_read_at_once() {
    let mut screen = Screen::new(FORM);
    screen.update();
    screen.patch(
        r#"{"op":"set","id":"sum","node":{"type":"input","props":{"id":"sum","value":"1,968","access":{"label":"Sum"}}}}"#,
    );
    screen.update();
    assert_eq!(screen.text(node_id("sum")), Some(heard("1,968", None)));
}

/// The run of field `field` that holds char `at` (as the adapter names a
/// position: AT-SPI's offsets made runs).
fn position(screen: &Screen, field: &str, run: usize, character_index: usize) -> TextPosition {
    let node = screen.heard(node_id(field)).unwrap();
    TextPosition {
        node: node.children()[run],
        character_index,
    }
}

#[test]
fn an_agent_sets_a_fields_text_and_selection() {
    let mut screen = Screen::new(FORM);
    screen.update();
    let (sum, note) = (node_id("sum"), node_id("note"));
    let value = |text: &str| ActionData::Value(text.into());

    // SetTextContents: the whole value.
    let set = value("Drafts");
    assert_eq!(
        screen.targets().request(Action::SetValue, sum, Some(&set)),
        Some(Request::SetText("sum", "Drafts".into()))
    );
    // ReplaceSelectedText: InsertText and DeleteText, after a selection.
    let insert = value(", bread");
    assert_eq!(
        screen
            .targets()
            .request(Action::ReplaceSelectedText, note, Some(&insert)),
        Some(Request::InsertText("note", ", bread".into()))
    );
    // A selection in the runs: chars of the field, across its lines.
    let selection = TextSelection {
        anchor: position(&screen, "note", 0, 4),
        focus: position(&screen, "note", 1, 3),
    };
    let data = ActionData::SetTextSelection(selection);
    assert_eq!(
        screen
            .targets()
            .request(Action::SetTextSelection, note, Some(&data)),
        Some(Request::Select("note", 4, 12))
    );
    // Another field's runs name nothing here.
    let elsewhere = TextSelection {
        anchor: position(&screen, "sum", 0, 0),
        focus: position(&screen, "sum", 0, 1),
    };
    let data = ActionData::SetTextSelection(elsewhere);
    assert_eq!(
        screen
            .targets()
            .request(Action::SetTextSelection, note, Some(&data)),
        None
    );
    // Without the text, or on what is not a field: nothing.
    assert_eq!(screen.targets().request(Action::SetValue, sum, None), None);
    assert_eq!(
        screen
            .targets()
            .request(Action::SetValue, NodeId(1), Some(&set)),
        None
    );
}

#[test]
fn a_fields_text_is_offered_for_editing() {
    let mut screen = Screen::new(FORM);
    screen.update();
    for field in ["sum", "note", "search", "pw"] {
        let node = screen.heard(node_id(field)).unwrap();
        for action in [
            Action::SetValue,
            Action::ReplaceSelectedText,
            Action::SetTextSelection,
        ] {
            assert!(node.supports_action(action), "{field} takes {action:?}");
        }
    }
}
