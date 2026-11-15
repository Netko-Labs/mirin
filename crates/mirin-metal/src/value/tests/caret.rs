//! The caret through a crossing: the app says where its caret is with each
//! tree (`selection`), and made that in the text it knew. A field that
//! typed meanwhile keeps its caret with what it typed.

use sumi::TestAppContext;

use super::{crossing, Caret, Dice, Driver, Host};
use crate::events::text_hash;

/// A field holding `text` with its caret at char `at`, and its driver.
fn line(cx: &mut TestAppContext, text: &str, at: usize) -> (Host, Driver) {
    let mut host = Host::new(cx, text);
    host.inputs
        .get_mut("line")
        .expect("the field")
        .field
        .place(at);
    (host, Driver::new(text))
}

/// The app writes `value` with its caret at `at`: the tree that says so.
fn writes(driver: &mut Driver, value: &str, at: usize) -> (String, Option<u32>, Caret) {
    let (value, base) = driver.sets(value).expect("a write");
    (value, base, driver.caret(at))
}

#[sumi::test]
fn a_caret_at_the_end_of_the_apps_write_stays_behind_keys_typed_before_it_arrived(
    cx: &mut TestAppContext,
) {
    // Calculator: a click on 7 (the app writes "7", its caret after it),
    // then "*6=" typed before the tree arrives.
    let (mut host, mut driver) = line(cx, "", 0);
    let (value, base, caret) = writes(&mut driver, "7", 1);
    host.types("*6=");
    for change in host.changes() {
        assert_eq!(driver.hears(&change), None);
    }
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("7*6=", 4));
    // The next key lands after them, not after the 7.
    host.types("!");
    assert_eq!(host.text(), "7*6=!");
}

#[sumi::test]
fn a_caret_at_the_end_of_a_write_made_before_hearing_a_key_stays_behind_it(
    cx: &mut TestAppContext,
) {
    // The other order: "*" is typed, and before the driver hears of it its
    // app writes "57" over the "5" it knows, its caret at the end.
    let (mut host, mut driver) = line(cx, "5", 1);
    host.types("*");
    let typed = host.changes();
    let (value, base, caret) = writes(&mut driver, "57", 2);
    assert_eq!(driver.hears(&typed[0]), None);
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("57*", 3));
    host.types("!");
    assert_eq!(host.text(), "57*!");
}

#[sumi::test]
fn a_caret_inside_the_line_stays_behind_the_keys_in_both_orders(cx: &mut TestAppContext) {
    // "12" with the caret after the 1. The keypad's 7 goes in there (the
    // app writes "172", its caret after the 7) as "*" is typed there.
    let (mut host, mut driver) = line(cx, "12", 1);
    let (value, base, caret) = writes(&mut driver, "172", 2);
    host.types("*");
    for change in host.changes() {
        assert_eq!(driver.hears(&change), None);
    }
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("17*2", 3));
    host.types("!");
    assert_eq!(host.text(), "17*!2");
    // Typed first, written before it was heard.
    let (mut host, mut driver) = line(cx, "12", 1);
    host.types("*");
    let typed = host.changes();
    let (value, base, caret) = writes(&mut driver, "172", 2);
    assert_eq!(driver.hears(&typed[0]), None);
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("17*2", 3));
    host.types("!");
    assert_eq!(host.text(), "17*!2");
}

#[sumi::test]
fn a_write_the_field_did_not_type_over_takes_the_apps_caret(cx: &mut TestAppContext) {
    // No crossing: the app heard "1250", tidied it and put its caret
    // after the comma.
    let (mut host, mut driver) = line(cx, "", 0);
    host.types("1250");
    for change in host.changes() {
        driver.hears(&change);
    }
    let (value, base, caret) = writes(&mut driver, "1,250", 2);
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("1,250", 2));
}

#[sumi::test]
fn a_caret_the_app_moves_without_writing_is_taken_only_in_the_text_it_was_made_in(
    cx: &mut TestAppContext,
) {
    // The app shows what it hears with its caret at the end, and hears no
    // selections: "1" comes back with a caret after it when the field
    // already holds "12".
    let (mut host, mut driver) = line(cx, "", 0);
    host.types("1");
    let heard = host.changes();
    host.types("2");
    let text = driver.hears(&heard[0]).expect("heard");
    let (value, base) = driver.sets(&text).expect("a new value");
    let caret = driver.caret(1);
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("12", 2));
    host.types("3");
    assert_eq!(host.text(), "123");
    // It is dropped for good: the same caret said again is no news.
    for change in host.changes() {
        driver.hears(&change);
    }
    let (value, base) = driver.sets("123").expect("a new value");
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("123", 3));
    // A caret made in the text the field holds goes where the app says.
    host.tree_with(cx, &value, base, Some(driver.caret(0)));
    assert_eq!((host.text(), host.caret()), ("123", 0));
}

#[sumi::test]
fn a_driver_that_names_no_text_still_loses_its_caret_to_a_rebase(cx: &mut TestAppContext) {
    // A driver from before a selection's `textHash`: the caret that comes
    // with a value the typing was carried onto is in that value.
    let (mut host, mut driver) = line(cx, "", 0);
    let (value, base) = driver.sets("7").expect("a write");
    host.types("*6=");
    let caret = Caret {
        at: 1,
        made_in: None,
    };
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("7*6=", 4));
    // Without a crossing it is taken, as before.
    let (mut host, mut driver) = line(cx, "", 0);
    let (value, base) = driver.sets("1,250").expect("a write");
    let caret = Caret {
        at: 2,
        made_in: None,
    };
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!(host.caret(), 2);
}

#[sumi::test]
fn a_field_whose_changes_the_driver_never_hears_takes_any_caret(cx: &mut TestAppContext) {
    use std::collections::HashMap;
    use std::sync::mpsc::channel;

    use crate::events::EventSender;
    use crate::sim::LayoutMap;
    use crate::tree::InputProps;
    use crate::value::sync_input;

    // No `onChange`: the driver knows only the value it set, so the text
    // it names is never the field's.
    let (tx, _sent) = channel();
    let events = EventSender::new(tx, LayoutMap::default());
    let mut inputs = HashMap::new();
    let props = |selection: serde_json::Value| -> InputProps {
        serde_json::from_value(serde_json::json!({ "id": "line", "selection": selection }))
            .expect("input props")
    };
    let made_in = text_hash("");
    let start = serde_json::json!({ "start": 0, "end": 0, "textHash": made_in });
    cx.update(|cx| sync_input(&mut inputs, &events, &props(start), cx));
    let state = inputs.get_mut("line").expect("the field");
    assert!(state.field.commit("typed", false));
    let all = serde_json::json!({ "start": 0, "end": 5, "textHash": made_in });
    cx.update(|cx| sync_input(&mut inputs, &events, &props(all), cx));
    assert_eq!(inputs["line"].field.selected_text(), "typed");
}

#[sumi::test]
fn carets_sent_with_every_tree_never_put_a_key_before_one_typed_earlier(cx: &mut TestAppContext) {
    // The crossings of `typing_and_writes_that_cross_in_any_order_lose_no_key`
    // with the app's caret in every tree, at the end of its text: the
    // letters stay in the order they were typed, and the digits in theirs.
    let mut dice = Dice(0xca2e7);
    for round in 0..300 {
        let (field, app, keys) = crossing(cx, &mut dice, true, "abcdefgh", "");
        assert_eq!(field, app, "round {round}");
        assert_eq!(field.len(), keys.len(), "round {round}: {field:?}");
        let letters: String = field.chars().filter(char::is_ascii_alphabetic).collect();
        let digits: String = field.chars().filter(char::is_ascii_digit).collect();
        assert_eq!(
            (letters.as_str(), digits.as_str()),
            ("abcdefgh", "12345678"),
            "round {round}: {field:?}"
        );
    }
}
