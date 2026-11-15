//! What a listening driver is told of the selection: what the field or the
//! person did, never what the driver's own tree said.

use std::collections::VecDeque;

use sumi::TestAppContext;

use super::{Caret, Driver, Host};

/// The tree's value again with the app's caret at `at`, made in what the
/// driver knows the field holds.
fn says(host: &mut Host, driver: &Driver, cx: &mut TestAppContext, at: usize) {
    let value = driver.value.clone();
    host.tree_with(cx, &value, None, Some(driver.caret(at)));
}

#[sumi::test]
fn a_caret_the_app_sets_as_the_person_moves_theirs_comes_to_rest(cx: &mut TestAppContext) {
    // An app that mirrors what it hears into `selection`. The person
    // presses Left (4 to 3) as the app puts its caret at 1: the report of
    // the 3 and the tree with the 1 cross.
    let mut host = Host::listening(cx, "abcd");
    let driver = Driver::new("abcd");
    says(&mut host, &driver, cx, 4);
    assert!(host.selections().is_empty());
    host.places(3);
    let mut trees: VecDeque<usize> = VecDeque::from([1]);
    let mut heard: VecDeque<(usize, usize)> = host.selections().into();
    assert_eq!(heard, [(3, 3)]);
    // Each takes the other's word in turn, the app answering every report
    // with a tree that says it, until neither has one.
    let (mut turns, mut reports) = (0, heard.len());
    while !trees.is_empty() || !heard.is_empty() {
        turns += 1;
        assert!(turns < 50, "the field and the app never agreed");
        if let Some(at) = trees.pop_front() {
            says(&mut host, &driver, cx, at);
            let told = host.selections();
            reports += told.len();
            heard.extend(told);
        }
        if let Some((_, end)) = heard.pop_front() {
            trees.push_back(end);
        }
    }
    // One report in all (the person's key), and the two agree: the app's
    // caret was taken, then the person's, which the app had mirrored.
    assert_eq!((reports, turns), (1, 2));
    assert_eq!(host.caret(), 3);
}

#[sumi::test]
fn a_selection_taken_as_the_tree_said_it_is_not_reported(cx: &mut TestAppContext) {
    let mut host = Host::listening(cx, "abcd");
    let mut driver = Driver::new("abcd");
    says(&mut host, &driver, cx, 1);
    assert_eq!(host.caret(), 1);
    assert!(host.selections().is_empty());
    // And again somewhere else, and back: each is taken, none said back.
    says(&mut host, &driver, cx, 4);
    says(&mut host, &driver, cx, 1);
    assert_eq!(host.caret(), 1);
    assert!(host.selections().is_empty());
    // With a value the app writes (a reset), too.
    let (value, base) = driver.sets("abcdef").expect("a write");
    host.tree_with(cx, &value, base, Some(driver.caret(2)));
    assert_eq!((host.text(), host.caret()), ("abcdef", 2));
    assert!(host.selections().is_empty());
}

#[sumi::test]
fn what_the_person_does_is_reported(cx: &mut TestAppContext) {
    let mut host = Host::listening(cx, "abcd");
    let driver = Driver::new("abcd");
    says(&mut host, &driver, cx, 1);
    // A click or an arrow key.
    host.places(3);
    assert_eq!(host.selections(), [(3, 3)]);
    // Typing.
    host.types("x");
    assert_eq!(host.selections(), [(4, 4)]);
    // Back where the app last put it: the person went there, and it is news.
    host.places(1);
    assert_eq!(host.selections(), [(1, 1)]);
}

#[sumi::test]
fn a_caret_a_rebase_kept_is_reported(cx: &mut TestAppContext) {
    // The keypad's 7 (the app's caret after it) as "*6=" is typed: the
    // field keeps its caret behind the keys, and says where.
    let mut host = Host::listening(cx, "");
    let mut driver = Driver::new("");
    let (value, base) = driver.sets("7").expect("a write");
    let caret = driver.caret(1);
    host.types("*6=");
    assert_eq!(host.selections(), [(1, 1), (2, 2), (3, 3)]);
    host.tree_with(cx, &value, base, Some(caret));
    assert_eq!((host.text(), host.caret()), ("7*6=", 4));
    assert_eq!(host.selections(), [(4, 4)]);
}

#[sumi::test]
fn a_selection_dropped_as_late_leaves_the_fields_caret_the_one_reported(cx: &mut TestAppContext) {
    // The app shows "1" with its caret after it when the field holds "12":
    // the selection is not taken, and what the driver last heard is the
    // field's caret, after the 2.
    let mut host = Host::listening(cx, "");
    let mut driver = Driver::new("");
    host.types("1");
    let heard = host.changes();
    host.types("2");
    assert_eq!(host.selections(), [(1, 1), (2, 2)]);
    let text = driver.hears(&heard[0]).expect("heard");
    let (value, base) = driver.sets(&text).expect("a new value");
    host.tree_with(cx, &value, base, Some(driver.caret(1)));
    assert_eq!((host.text(), host.caret()), ("12", 2));
    assert!(host.selections().is_empty());
    // The next move from there is news, though it is where the app said.
    host.places(1);
    assert_eq!(host.selections(), [(1, 1)]);
}

#[sumi::test]
fn a_caret_a_reset_put_at_the_end_by_itself_is_reported(cx: &mut TestAppContext) {
    // The app writes a value and says no selection: the caret goes to the
    // end of it, which is the field's doing.
    let mut host = Host::listening(cx, "ab");
    let mut driver = Driver::new("ab");
    host.places(1);
    assert_eq!(host.selections(), [(1, 1)]);
    let (value, base) = driver.sets("abcdef").expect("a write");
    host.tree(cx, &value, base);
    assert_eq!(host.caret(), 6);
    assert_eq!(host.selections(), [(6, 6)]);
}

#[sumi::test]
fn a_selection_the_field_could_not_take_as_said_is_reported(cx: &mut TestAppContext) {
    // Past the end of the text: the field puts it at the end, and says so.
    let mut host = Host::listening(cx, "abcd");
    let driver = Driver::new("abcd");
    says(&mut host, &driver, cx, 1);
    let far = Caret {
        at: 9,
        made_in: driver.caret(9).made_in,
    };
    host.tree_with(cx, "abcd", None, Some(far));
    assert_eq!(host.caret(), 4);
    assert_eq!(host.selections(), [(4, 4)]);
    // The app mirrors it: nothing more is said.
    says(&mut host, &driver, cx, 4);
    assert!(host.selections().is_empty());
}
