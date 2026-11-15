//! A key the app refuses: it writes its value again (a new `revision`),
//! over the text that had the key, and the keys typed after it stay.

use sumi::TestAppContext;

use super::{crossing, Dice, Driver, Host};
use crate::events::text_hash;

/// The app hears what the field typed so far, and shows it.
fn hears_all(host: &mut Host, driver: &mut Driver, cx: &mut TestAppContext) {
    for change in host.changes() {
        if let Some(text) = driver.hears(&change) {
            if let Some((value, base)) = driver.sets(&text) {
                host.tree(cx, &value, base);
            }
        }
    }
}

#[sumi::test]
fn taking_out_a_refused_key_keeps_the_keys_typed_after_it(cx: &mut TestAppContext) {
    // "12x+3" typed at once, and the app takes no "x".
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    host.types("12x+3");
    let typed = host.changes();
    // The app hears "1" and "12" and shows them, then "12x": it writes
    // "12" again, over the text with the x.
    for change in &typed[..2] {
        let text = driver.hears(change).expect("heard");
        let (value, base) = driver.sets(&text).expect("a new value");
        host.tree(cx, &value, base);
    }
    assert_eq!(driver.hears(&typed[2]).as_deref(), Some("12x"));
    let (value, base) = driver.rewrites("12");
    assert_eq!(base, Some(text_hash("12x")));
    // What was typed on the text with the x is not the app's.
    assert_eq!(driver.hears(&typed[3]), None);
    assert_eq!(driver.hears(&typed[4]), None);
    assert!(host.changes().is_empty());
    host.revision = 1;
    host.tree(cx, &value, base);
    // The field typed "+3" again on the app's text, its caret after them.
    assert_eq!((host.text(), host.caret()), ("12+3", 4));
    let changes = host.changes();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].base_hash, Some(text_hash("12")));
    assert_eq!(driver.hears(&changes[0]).as_deref(), Some("12+3"));
    // The app shows it, and the two agree.
    let (value, base) = driver.sets("12+3").expect("a new value");
    host.tree(cx, &value, base);
    assert_eq!(host.text(), driver.value);
    assert!(host.changes().is_empty());
}

#[sumi::test]
fn a_refused_key_with_nothing_typed_after_it_is_just_taken_out(cx: &mut TestAppContext) {
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    host.types("12");
    hears_all(&mut host, &mut driver, cx);
    host.types("x");
    let typed = host.changes();
    assert_eq!(driver.hears(&typed[0]).as_deref(), Some("12x"));
    let (value, base) = driver.rewrites("12");
    host.revision = 1;
    host.tree(cx, &value, base);
    assert_eq!((host.text(), host.caret()), ("12", 2));
    assert!(
        host.changes().is_empty(),
        "a reset is the driver's own news"
    );
}

#[sumi::test]
fn a_value_written_again_over_the_text_the_field_holds_is_a_reset(cx: &mut TestAppContext) {
    // No key refused: the app writes its text again, and the field holds
    // it. The caret goes to its end, as a reset's does.
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    host.types("12");
    hears_all(&mut host, &mut driver, cx);
    host.inputs
        .get_mut("line")
        .expect("the field")
        .field
        .place(0);
    let (value, base) = driver.rewrites("12");
    assert_eq!(base, Some(text_hash("12")));
    host.revision = 1;
    host.tree(cx, &value, base);
    assert_eq!((host.text(), host.caret()), ("12", 2));
    // And typed into since: the typing stays.
    host.types("+");
    let (value, base) = driver.rewrites("12");
    host.revision = 2;
    host.tree(cx, &value, base);
    assert_eq!((host.text(), host.caret()), ("12+", 3));
}

#[sumi::test]
fn a_new_revision_from_a_driver_that_names_no_text_resets_as_before(cx: &mut TestAppContext) {
    let mut host = Host::new(cx, "");
    host.types("12x+3");
    host.revision = 1;
    host.tree(cx, "12", None);
    assert_eq!((host.text(), host.caret()), ("12", 2));
}

#[sumi::test]
fn refused_keys_among_typing_and_writes_that_cross_cost_no_other_key(cx: &mut TestAppContext) {
    // The crossings of `typing_and_writes_that_cross_in_any_order_lose_no_key`
    // with two letters the app refuses among those typed, with and without
    // the app's caret in every tree: when all have arrived the two hold
    // the same text, every other key in it once and in the order typed.
    let mut dice = Dice(0x0e_f05e);
    for round in 0..300 {
        let carets = round % 2 == 1;
        let (field, app, keys) = crossing(cx, &mut dice, carets, "axbcxdef", "x");
        assert_eq!(field, app, "round {round}");
        assert_eq!(field.len(), keys.len() - 2, "round {round}: {field:?}");
        let letters: String = field.chars().filter(char::is_ascii_alphabetic).collect();
        let digits: String = field.chars().filter(char::is_ascii_digit).collect();
        assert_eq!(
            (letters.as_str(), digits.as_str()),
            ("abcdef", "12345678"),
            "round {round}: {field:?}"
        );
    }
}
