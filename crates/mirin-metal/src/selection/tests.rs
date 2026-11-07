//! A press in a field and the pointer after it: moves and a release heard
//! in any order, or not at all.

use super::SelectionState;
use crate::field::Field;

/// A press at char `at` in a single-line field, as a click makes it.
fn pressed(field: &mut Field, at: usize, clicks: usize) -> SelectionState {
    let (press, _) = field.press(at, clicks, false, false);
    SelectionState {
        pressing: Some(press),
        ..SelectionState::default()
    }
}

#[test]
fn a_drag_whose_moves_were_missed_still_selects_to_where_it_lifted() {
    // A click, then at once a quick drag from "one" to "three": the
    // window drew no frame between the press and the release, so no
    // move was heard. The release ends the drag where it lifted.
    let mut field = Field::new("one two three");
    let mut selection = pressed(&mut field, 0, 1);
    assert!(selection.released(&mut field, Some(13), false));
    assert_eq!(field.selected_text(), "one two three");
    assert!(selection.pressing.is_none());
    // Heard moves select on the way, and the release keeps the end.
    let mut selection = pressed(&mut field, 4, 1);
    assert!(selection.pointer_moved(&mut field, Some(6), true, false));
    assert_eq!(field.selected_text(), "tw");
    assert!(selection.released(&mut field, Some(7), false));
    assert_eq!(field.selected_text(), "two");
}

#[test]
fn a_click_selects_nothing_on_release_and_a_double_click_keeps_its_word() {
    let mut field = Field::new("one two");
    let mut selection = pressed(&mut field, 5, 1);
    assert!(!selection.released(&mut field, Some(5), false));
    assert_eq!((field.cursor, field.has_selection()), (5, false));
    let mut selection = pressed(&mut field, 5, 2);
    assert!(!selection.released(&mut field, Some(5), false));
    assert_eq!(field.selected_text(), "two");
}

#[test]
fn the_pointer_without_a_press_moves_nothing() {
    // Every drawn field hears every move and release.
    let mut field = Field::new("one two");
    field.place(3);
    let mut selection = SelectionState::default();
    assert!(!selection.pointer_moved(&mut field, Some(6), true, false));
    assert!(!selection.released(&mut field, Some(6), false));
    assert_eq!((field.cursor, field.has_selection()), (3, false));
}

#[test]
fn a_move_with_the_button_up_ends_a_press_whose_release_was_lost() {
    let mut field = Field::new("one two");
    let mut selection = pressed(&mut field, 1, 1);
    assert!(!selection.pointer_moved(&mut field, Some(6), false, false));
    assert!(selection.pressing.is_none());
    assert_eq!((field.cursor, field.has_selection()), (1, false));
}

#[test]
fn a_reported_selection_names_the_text_it_is_in() {
    // A driver that replaced the text ("1250" tidied to "1,250") tells a
    // late report for the old text from one for its own by the hash.
    use crate::events::{text_hash, EventKind, EventSender};
    use crate::sim::LayoutMap;
    use crate::tree::InputProps;

    let (tx, rx) = std::sync::mpsc::channel();
    let events = EventSender::new(tx, LayoutMap::default());
    let mut field = Field::new("1250");
    let props: InputProps =
        serde_json::from_value(serde_json::json!({ "id": "line", "onSelection": true }))
            .expect("input props");
    let mut selection = SelectionState::new(&mut field, &props);
    field.place(2);
    selection.report("line", &field, &events);
    let event = rx.try_recv().expect("a report");
    assert_eq!(
        event.kind,
        EventKind::Selection {
            start: 2,
            end: 2,
            text_hash: text_hash("1250"),
        }
    );
    field.reset("1,250");
    selection.report("line", &field, &events);
    let event = rx.try_recv().expect("a report");
    assert_eq!(
        event.kind,
        EventKind::Selection {
            start: 5,
            end: 5,
            text_hash: text_hash("1,250"),
        }
    );
}
