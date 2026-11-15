//! A field's text with two writers: the host's half (`sync_input`, the
//! `change` events) against a driver that does what `@mirinjs/metal` does
//! (`lib/field-texts.ts`): it says with each value which text its app set
//! it over, and drops a change made on a text its app has since replaced.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{channel, Receiver};

use sumi::TestAppContext;

use super::{driver_resets, report_change, sync_input};
use crate::events::{text_hash, EventKind, EventSender, NativeUiEvent};
use crate::sim::LayoutMap;
use crate::tree::InputProps;
use crate::window::InputState;

fn sent(values: &[&str]) -> VecDeque<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn late_echoes_never_reset_the_buffer() {
    // Typed "abc" faster than the driver answers; its "a" arrives last.
    let mut echoes = sent(&["a", "ab", "abc"]);
    assert!(!driver_resets(&mut echoes, "a"));
    assert_eq!(echoes, sent(&["ab", "abc"]));
    // A driver that batches may skip straight to the newest.
    assert!(!driver_resets(&mut echoes, "abc"));
    assert!(echoes.is_empty());
}

#[test]
fn a_new_value_from_the_driver_wins() {
    let mut echoes = sent(&["pass"]);
    assert!(driver_resets(&mut echoes, ""));
    assert!(echoes.is_empty());
    assert!(driver_resets(&mut echoes, "ABC"));
}

/// The app's caret in a tree (`selection`, nothing selected): where, and
/// the hash of the text it was made in (`None`: a driver that doesn't say).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Caret {
    at: usize,
    made_in: Option<u32>,
}

/// A `change` as it crosses to the driver.
#[derive(Debug, Clone, PartialEq)]
struct Change {
    value: String,
    base_hash: Option<u32>,
    text_hash: u32,
}

/// The host's half: one field, and the events it sent.
struct Host {
    inputs: HashMap<String, InputState>,
    events: EventSender,
    sent: Receiver<NativeUiEvent>,
}

impl Host {
    fn new(cx: &mut TestAppContext, value: &str) -> Self {
        let (tx, sent) = channel();
        let mut host = Self {
            inputs: HashMap::new(),
            events: EventSender::new(tx, LayoutMap::default()),
            sent,
        };
        host.tree(cx, value, None);
        host
    }

    /// A tree arrives with the field's `value`, set over the text hashing to `base_hash`.
    fn tree(&mut self, cx: &mut TestAppContext, value: &str, base_hash: Option<u32>) {
        self.tree_with(cx, value, base_hash, None);
    }

    /// And with the app's `caret`, when it sends one.
    fn tree_with(
        &mut self,
        cx: &mut TestAppContext,
        value: &str,
        base_hash: Option<u32>,
        caret: Option<Caret>,
    ) {
        let mut json = serde_json::json!({ "id": "line", "value": value, "onChange": true });
        if let Some(base_hash) = base_hash {
            json["baseHash"] = serde_json::json!(base_hash);
        }
        if let Some(caret) = caret {
            json["selection"] = serde_json::json!({ "start": caret.at, "end": caret.at });
            if let Some(made_in) = caret.made_in {
                json["selection"]["textHash"] = serde_json::json!(made_in);
            }
        }
        let props: InputProps = serde_json::from_value(json).expect("input props");
        cx.update(|cx| sync_input(&mut self.inputs, &self.events, &props, cx));
    }

    /// Where the field's caret is (a char index).
    fn caret(&self) -> usize {
        self.inputs["line"].field.cursor
    }

    /// The person types `text` at the caret, a key at a time.
    fn types(&mut self, text: &str) {
        let state = self.inputs.get_mut("line").expect("the field");
        for key in text.chars() {
            assert!(state.field.commit(&key.to_string(), false));
            report_change(state, "line", &self.events);
        }
    }

    fn text(&self) -> &str {
        &self.inputs["line"].field.buffer
    }

    /// The changes sent since last asked, oldest first.
    fn changes(&self) -> Vec<Change> {
        self.sent
            .try_iter()
            .filter_map(|event| match event.kind {
                EventKind::Change {
                    value,
                    base_hash,
                    text_hash,
                } => Some(Change {
                    value,
                    base_hash,
                    text_hash,
                }),
                _ => None,
            })
            .collect()
    }
}

/// The driver's half, as `lib/field-texts.ts` keeps it: what the field
/// holds as far as it can tell, and its app's value.
struct Driver {
    holds: String,
    value: String,
}

impl Driver {
    fn new(value: &str) -> Self {
        Self {
            holds: value.to_owned(),
            value: value.to_owned(),
        }
    }

    /// The app sets `value`: the tree's value and `baseHash`, when it is news.
    fn sets(&mut self, value: &str) -> Option<(String, Option<u32>)> {
        if self.value == value {
            return None;
        }
        let base_hash = text_hash(&self.holds);
        self.holds = value.to_owned();
        self.value = value.to_owned();
        Some((value.to_owned(), Some(base_hash)))
    }

    /// The app's caret at `at` in its text, named as the driver names it:
    /// made in what the field holds, as far as it can tell.
    fn caret(&self, at: usize) -> Caret {
        Caret {
            at,
            made_in: Some(text_hash(&self.holds)),
        }
    }

    /// A change arrives: the text the app hears, unless it was made on a
    /// text the app has since replaced.
    fn hears(&mut self, change: &Change) -> Option<String> {
        if change
            .base_hash
            .is_some_and(|base| base != text_hash(&self.holds))
        {
            return None;
        }
        self.holds = change.value.clone();
        Some(change.value.clone())
    }
}

#[sumi::test]
fn a_change_names_the_text_it_was_typed_on_and_the_text_it_made(cx: &mut TestAppContext) {
    let mut host = Host::new(cx, "12");
    host.types("5");
    host.types("0");
    assert_eq!(
        host.changes(),
        [
            Change {
                value: "125".into(),
                base_hash: Some(text_hash("12")),
                text_hash: text_hash("125"),
            },
            Change {
                value: "1250".into(),
                base_hash: Some(text_hash("125")),
                text_hash: text_hash("1250"),
            },
        ]
    );
    // The app tidies it: typed on its text from here.
    host.tree(cx, "1,250", Some(text_hash("1250")));
    host.types("3");
    assert_eq!(host.changes()[0].base_hash, Some(text_hash("1,250")));
}

#[sumi::test]
fn keys_typed_before_the_apps_write_arrives_land_after_it(cx: &mut TestAppContext) {
    // Calculator: a click on 7 (the app writes "7"), then "*6=" typed at
    // once. The keys reach the field before the tree does.
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    let write = driver.sets("7").expect("a write");
    host.types("*6=");
    // The driver hears three changes made on the empty text: not its app's.
    let heard: Vec<_> = host
        .changes()
        .iter()
        .filter_map(|change| driver.hears(change))
        .collect();
    assert!(heard.is_empty(), "{heard:?}");
    // The field takes the write with what was typed carried onto it, and says so.
    host.tree(cx, &write.0, write.1);
    assert_eq!(host.text(), "7*6=");
    assert_eq!(host.inputs["line"].field.cursor, 4);
    let changes = host.changes();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].base_hash, Some(text_hash("7")));
    assert_eq!(driver.hears(&changes[0]).as_deref(), Some("7*6="));
    // The app shows it: the field's own text, back.
    let echo = driver.sets("7*6=").expect("a new value");
    assert_eq!(echo.1, Some(text_hash("7*6=")));
    host.tree(cx, &echo.0, echo.1);
    assert_eq!(host.text(), "7*6=");
    assert!(host.changes().is_empty());
}

#[sumi::test]
fn a_key_typed_first_and_heard_after_the_apps_write_is_kept(cx: &mut TestAppContext) {
    // The other order: "*" is typed, and before the driver hears of it its
    // app writes "57" over the "5" it knows.
    let mut host = Host::new(cx, "5");
    let mut driver = Driver::new("5");
    host.types("*");
    let typed = host.changes();
    let write = driver.sets("57").expect("a write");
    assert_eq!(
        driver.hears(&typed[0]),
        None,
        "typed on a text the app replaced"
    );
    host.tree(cx, &write.0, write.1);
    assert_eq!(host.text(), "57*");
    let changes = host.changes();
    assert_eq!(driver.hears(&changes[0]).as_deref(), Some("57*"));
}

#[sumi::test]
fn a_write_made_after_hearing_what_was_typed_replaces_it(cx: &mut TestAppContext) {
    // No crossing: the app heard "1250" and tidied it.
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    host.types("1250");
    for change in host.changes() {
        driver.hears(&change);
    }
    let write = driver.sets("1,250").expect("a write");
    host.tree(cx, &write.0, write.1);
    assert_eq!(host.text(), "1,250");
    assert!(
        host.changes().is_empty(),
        "a reset is the driver's own news"
    );
}

#[sumi::test]
fn an_older_text_of_the_fields_set_after_a_newer_one_was_heard_is_a_write(cx: &mut TestAppContext) {
    // An app that keeps two characters hears "a", "ab", "abc" in one go and
    // shows "ab": the field's own older text, but not an echo of it.
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    host.types("abc");
    for change in host.changes() {
        driver.hears(&change);
    }
    let write = driver.sets("ab").expect("a write");
    assert_eq!(write.1, Some(text_hash("abc")));
    host.tree(cx, &write.0, write.1);
    assert_eq!(host.text(), "ab");
    // A driver that names no text can't say so, and the field keeps "abc".
    let mut host = Host::new(cx, "");
    host.types("abc");
    host.tree(cx, "ab", None);
    assert_eq!(host.text(), "abc");
}

#[sumi::test]
fn a_driver_that_names_no_text_is_answered_as_before(cx: &mut TestAppContext) {
    let mut host = Host::new(cx, "");
    host.types("ab");
    // Its late echo of "a" is not a reset; its own text is, and drops what was typed.
    host.tree(cx, "a", None);
    assert_eq!(host.text(), "ab");
    host.types("c");
    host.tree(cx, "7", None);
    assert_eq!(host.text(), "7");
}

#[sumi::test]
fn a_field_that_reports_no_changes_takes_the_apps_value_whole(cx: &mut TestAppContext) {
    let (tx, sent) = channel();
    let events = EventSender::new(tx, LayoutMap::default());
    let mut inputs = HashMap::new();
    let props = |value: &str, base: Option<u32>| -> InputProps {
        serde_json::from_value(
            serde_json::json!({ "id": "line", "value": value, "baseHash": base }),
        )
        .expect("input props")
    };
    cx.update(|cx| sync_input(&mut inputs, &events, &props("", None), cx));
    let state = inputs.get_mut("line").expect("the field");
    assert!(state.field.commit("typed", false));
    cx.update(|cx| sync_input(&mut inputs, &events, &props("set", Some(text_hash(""))), cx));
    assert_eq!(inputs["line"].field.buffer, "set");
    assert!(sent.try_iter().next().is_none());
}

/// A small generator, the same on every run.
struct Dice(u64);

impl Dice {
    fn roll(&mut self, sides: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % sides
    }
}

/// One round of typing and writes crossing as the dice say: the person
/// types letters while the app's keypad writes digits at the end of its
/// text, and the trees and the events cross as they like until all have
/// arrived. With `carets`, every tree says the app's caret, at the end of
/// its text. Answers the field's text, the app's, and the keys pressed.
fn crossing(cx: &mut TestAppContext, dice: &mut Dice, carets: bool) -> (String, String, String) {
    let mut host = Host::new(cx, "");
    let mut driver = Driver::new("");
    let mut trees: VecDeque<(String, Option<u32>, Option<Caret>)> = VecDeque::new();
    let mut events: VecDeque<Change> = VecDeque::new();
    let mut keys = String::new();
    let (mut letters, mut digits) = ('a'..='h', '1'..='8');
    // The app sets `value`: the tree that says so, when it is news.
    let write = |driver: &mut Driver, value: &str| {
        let (value, base) = driver.sets(value)?;
        let caret = carets.then(|| driver.caret(value.chars().count()));
        Some((value, base, caret))
    };
    let mut steps = 0;
    loop {
        let typing = letters.clone().next().is_some() || digits.clone().next().is_some();
        if !typing && trees.is_empty() && events.is_empty() {
            break;
        }
        steps += 1;
        assert!(steps < 10_000, "a round never came to rest");
        match dice.roll(4) {
            0 => {
                if let Some(letter) = letters.next() {
                    host.types(&letter.to_string());
                    events.extend(host.changes());
                    keys.push(letter);
                }
            }
            1 => {
                if let Some(digit) = digits.next() {
                    let value = format!("{}{digit}", driver.value);
                    trees.extend(write(&mut driver, &value));
                    keys.push(digit);
                }
            }
            2 => {
                if let Some((value, base, caret)) = trees.pop_front() {
                    host.tree_with(cx, &value, base, caret);
                    events.extend(host.changes());
                }
            }
            _ => {
                if let Some(change) = events.pop_front() {
                    // The app shows what it hears.
                    if let Some(text) = driver.hears(&change) {
                        trees.extend(write(&mut driver, &text));
                    }
                }
            }
        }
    }
    (host.text().to_owned(), driver.value, keys)
}

#[sumi::test]
fn typing_and_writes_that_cross_in_any_order_lose_no_key(cx: &mut TestAppContext) {
    // When all have arrived the two hold the same text, with every key in
    // it once.
    let mut dice = Dice(0x5eed);
    for round in 0..300 {
        let (field, app, keys) = crossing(cx, &mut dice, false);
        assert_eq!(field, app, "round {round}");
        let mut held: Vec<char> = field.chars().collect();
        let mut typed: Vec<char> = keys.chars().collect();
        held.sort_unstable();
        typed.sort_unstable();
        assert_eq!(held, typed, "round {round}: {field:?}");
    }
}

mod caret;
