//! Changes to the tree, the keyboard and single nodes' bounds: an update
//! carries only what changed.

use accesskit::Role;

use super::screen::{at, Screen, Took};
use crate::access::tree::{node_id, ROOT};
use crate::tree::parse_tree;

pub(super) const LAUNCHER: &str = r##"{"type":"view","props":{"id":"1"},"children":[
    {"type":"input","props":{"id":"field","value":"w","access":{"role":"combobox","label":"Search"}}},
    {"type":"view","props":{"id":"list","access":{"role":"listbox","label":"Results"}},"children":[
        {"type":"view","props":{"id":"r1","onPress":true,"access":{"role":"option","selected":true}},
         "children":[{"type":"text","props":{"id":"t1"},"children":["Wi-Fi"]}]},
        {"type":"view","props":{"id":"r2","onPress":true,"access":{"role":"option","selected":false}},
         "children":[{"type":"text","props":{"id":"t2"},"children":["Network"]}]},
        {"type":"view","props":{"id":"r3","onPress":true,"focusable":true},
         "children":[{"type":"view","props":{"id":"g3"},"children":[{"type":"text","props":{"id":"t3"},"children":["Sound"]}]}]}
    ]},
    {"type":"view","props":{"id":"side"},"children":[
        {"type":"text","props":{"id":"t4"},"children":["Recent"]},
        {"type":"input","props":{"id":"pw","value":"hunter2","secure":true}}
    ]},
    {"type":"view","props":{"id":"note","access":{"role":"status","label":"Copied","live":"polite"}}}
]}"##;

pub(super) fn row(id: &str, selected: bool) -> String {
    format!(
        r#"{{"type":"view","props":{{"id":"{id}","onPress":true,"access":{{"role":"option","selected":{selected}}}}}}}"#
    )
}

pub(super) fn text(id: &str, words: &str) -> String {
    format!(r#"{{"type":"text","props":{{"id":"{id}"}},"children":["{words}"]}}"#)
}

#[test]
fn an_update_carries_only_what_changed() {
    let mut screen = Screen::new(LAUNCHER);
    let first = screen.update();
    assert_eq!(first.sent, 12, "the first tree is whole");
    assert_eq!(screen.update().sent, 0, "nothing changed");

    // A text's words: its label alone.
    screen.patch(&format!(
        r#"{{"op":"set","id":"t2","node":{}}}"#,
        text("t2", "Ethernet")
    ));
    // Made again on the way down to it: the window, the field beside the
    // list, the list, the row, the text. The other rows and views were skipped.
    assert_eq!(screen.update(), Took { built: 5, sent: 1 });

    // A style a screen reader never hears of: nothing.
    screen.patch(
        r##"{"op":"set","id":"r2","node":{"type":"view","props":{"id":"r2","onPress":true,
            "background":"#1e3a8a","access":{"role":"option","selected":false}}}}"##,
    );
    assert_eq!(screen.update().sent, 0);

    // The selection moves: the two options.
    screen.patch(&format!(
        r#"{{"op":"set","id":"r1","node":{}}},{{"op":"set","id":"r2","node":{}}}"#,
        row("r1", false),
        row("r2", true)
    ));
    assert_eq!(screen.update().sent, 2);
}

#[test]
fn rows_come_go_and_move() {
    let mut screen = Screen::new(LAUNCHER);
    screen.update();
    let list = node_id("list");

    // A new row with its text: the row, its label, and the list it joined.
    screen.patch(&format!(
        r#"{{"op":"insert","parent":"list","before":"r2","node":
            {{"type":"view","props":{{"id":"r9","onPress":true}},"children":[{}]}}}}"#,
        text("t9", "Bluetooth")
    ));
    assert_eq!(screen.update().sent, 3);
    let children = screen.heard(list).unwrap().children().to_vec();
    assert_eq!(
        children,
        ["r1", "r9", "r2", "r3"].map(node_id),
        "in the order of the tree"
    );

    // A reorder within the list: the list alone.
    screen.patch(r#"{"op":"move","id":"r3","parent":"list","before":"r1"}"#);
    assert_eq!(screen.update().sent, 1);

    // A row leaves: the list alone names it no more, and it is gone.
    screen.patch(r#"{"op":"remove","id":"r9"}"#);
    assert_eq!(screen.update().sent, 1);
    assert!(screen.heard(node_id("r9")).is_none());

    // A row moves to another parent (a layout view: it joins the window).
    screen.patch(r#"{"op":"move","id":"r2","parent":"side"}"#);
    screen.update();
    assert!(screen
        .heard(ROOT)
        .unwrap()
        .children()
        .contains(&node_id("r2")));

    // Gone and back under the same id in one patch, with other words.
    screen.patch(&format!(
        r#"{{"op":"remove","id":"r1"}},{{"op":"insert","parent":"list","node":
            {{"type":"view","props":{{"id":"r1","onPress":true}},"children":[{}]}}}}"#,
        text("t1b", "Wi-Fi 6")
    ));
    screen.update();

    // A text in front of another: the one behind has a new place, so a new id.
    screen.patch(&format!(
        r#"{{"op":"insert","parent":"side","before":"t4","node":{}}}"#,
        text("t0", "Pinned")
    ));
    screen.update();
    // Its words go: it is no node at all.
    screen.patch(&format!(
        r#"{{"op":"set","id":"t0","node":{}}}"#,
        text("t0", " ")
    ));
    screen.update();
}

#[test]
fn what_a_view_is_changes() {
    let mut screen = Screen::new(LAUNCHER);
    screen.update();
    // A layout view says what it is: its children are its own now.
    screen.patch(
        r#"{"op":"set","id":"side","node":{"type":"view","props":{"id":"side","access":{"role":"group","label":"Side"}}}}"#,
    );
    screen.update();
    assert_eq!(screen.heard(node_id("side")).unwrap().children().len(), 2);
    // A label that stands for its content: nothing under it is a node.
    screen.patch(
        r#"{"op":"set","id":"r3","node":{"type":"view","props":{"id":"r3","onPress":true,"access":{"label":"Sound, setting"}}}}"#,
    );
    screen.update();
    assert!(
        screen.heard(node_id("g3/0")).is_none(),
        "its text is not read twice"
    );
    // And back to layout only.
    screen.patch(r#"{"op":"set","id":"side","node":{"type":"view","props":{"id":"side"}}}"#);
    screen.patch(
        r#"{"op":"set","id":"r3","node":{"type":"view","props":{"id":"r3","onPress":true}}}"#,
    );
    screen.update();
    assert!(screen.heard(node_id("side")).is_none());
    assert!(screen.heard(node_id("g3/0")).is_some());
}

#[test]
fn the_keyboard_moves_and_types() {
    let mut screen = Screen::new(LAUNCHER);
    screen.update();
    let field = node_id("field");

    // The field takes the keyboard: it points at the selected option.
    screen.focus(Some("field"), Some("w"));
    assert_eq!(screen.update().sent, 1);
    let heard = screen.heard(field).unwrap();
    assert_eq!(heard.role(), Role::EditableComboBox);
    assert_eq!(heard.active_descendant(), Some(node_id("r1")));

    // Typing: the field alone, with the typed words (the driver's lag).
    screen.focus(Some("field"), Some("wi"));
    assert_eq!(screen.update(), Took { built: 1, sent: 1 });
    assert_eq!(screen.heard(field).unwrap().value(), Some("wi"));

    // The selection moves under it: the options and what the field points at.
    screen.patch(&format!(
        r#"{{"op":"set","id":"r1","node":{}}},{{"op":"set","id":"r2","node":{}}}"#,
        row("r1", false),
        row("r2", true)
    ));
    assert_eq!(screen.update().sent, 3);
    assert_eq!(
        screen.heard(field).unwrap().active_descendant(),
        Some(node_id("r2"))
    );

    // A focusable view takes it: the field says the driver's value again.
    screen.focus(Some("r3"), None);
    assert_eq!(screen.update().sent, 1);
    let heard = screen.heard(field).unwrap();
    assert_eq!(heard.value(), Some("w"));
    assert_eq!(heard.active_descendant(), None);

    // A password field's words are never published, typed or not.
    screen.focus(Some("pw"), Some("hunter2!"));
    assert_eq!(screen.update().sent, 0);
    assert_eq!(screen.heard(node_id("pw")).unwrap().value(), None);

    // The focused row leaves the tree: the window has the focus.
    screen.patch(r#"{"op":"remove","id":"r3"}"#);
    screen.focus(Some("r3"), None);
    screen.update();
    screen.focus(None, None);
    screen.update();
}

#[test]
fn bounds_follow_the_paint_not_the_tree() {
    let mut screen = Screen::new(LAUNCHER);
    screen.update();

    // One row painted elsewhere, the tree the same: that node alone.
    screen.paint("r2", Some(at(0.0, 40.0)));
    assert_eq!(screen.update(), Took { built: 1, sent: 1 });
    assert_eq!(
        screen.heard(node_id("r2")).unwrap().bounds(),
        Some(at(0.0, 40.0))
    );

    // Scrolled out of sight (not painted): it has no bounds, not stale ones.
    screen.paint("r2", None);
    assert_eq!(screen.update().sent, 1);
    assert_eq!(screen.heard(node_id("r2")).unwrap().bounds(), None);

    // A scroll: every painted node moved; texts have no bounds of their own.
    for (index, id) in ["field", "list", "r1", "r2", "r3", "pw", "note"]
        .into_iter()
        .enumerate()
    {
        let y = 100.0 + 20.0 * index as f64;
        screen.paint(id, Some(at(0.0, y)));
    }
    assert_eq!(screen.update().sent, 7);

    // A patch and a move in the same frame.
    screen.patch(&format!(
        r#"{{"op":"set","id":"t1","node":{}}}"#,
        text("t1", "Wi-Fi 6")
    ));
    screen.paint("note", Some(at(5.0, 5.0)));
    assert_eq!(screen.update().sent, 2);

    // A view's own props change and it paints nothing under it any more,
    // with nothing else moving (so the layout has nothing to say): the rows
    // under it lose their bounds all the same.
    screen.patch(
        r#"{"op":"set","id":"list","node":{"type":"view","props":{"id":"list","height":0,
            "access":{"role":"listbox","label":"Results"}}}}"#,
    );
    for id in ["r1", "r2", "r3"] {
        screen.painted.insert(id.to_owned(), None);
    }
    assert_eq!(screen.update().sent, 3);
    assert_eq!(screen.heard(node_id("r1")).unwrap().bounds(), None);
}

#[test]
fn a_whole_tree_and_a_new_title() {
    let mut screen = Screen::new(LAUNCHER);
    screen.update();
    screen.title = "Launcher: wi".to_owned();
    assert_eq!(screen.update(), Took { built: 1, sent: 1 });

    // A resync: the same tree whole. Every node is made again, none differs.
    screen
        .document
        .replace(parse_tree(LAUNCHER).expect("the tree parses"));
    assert_eq!(screen.update(), Took { built: 12, sent: 0 });

    // Then patches again.
    screen.patch(r#"{"op":"remove","id":"list"}"#);
    assert_eq!(screen.update().sent, 1);

    // Another tree altogether, from a driver that names only what it must.
    screen.document.replace(
        parse_tree(
            r#"{"type":"view","children":[
                {"type":"view","props":{"onPress":true},"children":[{"type":"text","children":["OK"]}]},
                {"type":"input","props":{"id":"field","value":""}}
            ]}"#,
        )
        .expect("the tree parses"),
    );
    screen.update();
    screen.update();
}
