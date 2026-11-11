//! The tree kept across updates (`published.rs`) against one made from
//! nothing, update after update: what a screen reader has after hearing only
//! the changed nodes is what it would have been handed whole. And what the
//! application is called.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use accesskit::{Node, NodeId, Rect, Role};
use accesskit_consumer::{NodeRef, Tree, TreeChangeHandler};

use super::app_name;
use super::published::Published;
use super::tree::{node_id, Facts, Targets, ROOT};
use crate::patch::{parse_patch, Document};
use crate::tree::parse_tree;

struct Quiet;

impl TreeChangeHandler for Quiet {
    fn node_added(&mut self, _: &NodeRef) {}
    fn node_updated(&mut self, _: &NodeRef, _: &NodeRef) {}
    fn focus_moved(&mut self, _: Option<&NodeRef>, _: Option<&NodeRef>) {}
    fn node_removed(&mut self, _: &NodeRef) {}
}

/// Every node under the root of AccessKit's own tree, by id.
fn nodes_of(tree: &Tree) -> BTreeMap<u64, Node> {
    fn gather(node: &NodeRef, nodes: &mut BTreeMap<u64, Node>) {
        nodes.insert(node.locate().0 .0, node.data().clone());
        for child in node.children() {
            gather(&child, nodes);
        }
    }
    let mut nodes = BTreeMap::new();
    gather(&tree.state().root(), &mut nodes);
    nodes
}

fn at(x: f64, y: f64) -> Rect {
    Rect::new(x, y, x + 10.0, y + 10.0)
}

/// A window as the host has it: the tree patches change, what the renderer
/// knows, the tree kept for the adapter, and AccessKit's tree hearing every
/// update (it panics on one that names a node it cannot place).
struct Screen {
    document: Document,
    title: String,
    /// Where elements were painted, when not at the origin; None is not painted.
    painted: HashMap<String, Option<Rect>>,
    /// The layout says bounds moved since the last update.
    moved: bool,
    focused: Option<String>,
    typed: Option<String>,
    published: Published,
    targets: Mutex<Targets>,
    heard: Option<Tree>,
}

/// What one update took: nodes made from their elements, nodes handed over.
#[derive(Debug, PartialEq, Eq)]
struct Took {
    built: usize,
    sent: usize,
}

impl Screen {
    fn new(json: &str) -> Self {
        Self {
            document: Document::new(parse_tree(json).expect("the tree parses")),
            title: "Launcher".to_owned(),
            painted: HashMap::new(),
            moved: false,
            focused: None,
            typed: None,
            published: Published::default(),
            targets: Mutex::default(),
            heard: None,
        }
    }

    fn patch(&mut self, ops: &str) {
        let ops = parse_patch(&format!(r#"{{"patch":[{ops}]}}"#)).expect("the patch parses");
        self.document.apply(ops).expect("the patch applies");
    }

    /// `id` is painted at `bounds` now (not at all for None), and the layout
    /// says so.
    fn paint(&mut self, id: &str, bounds: Option<Rect>) {
        self.painted.insert(id.to_owned(), bounds);
        self.moved = true;
    }

    fn focus(&mut self, id: Option<&str>, typed: Option<&str>) {
        self.focused = id.map(str::to_owned);
        self.typed = typed.map(str::to_owned);
    }

    /// One update, as after a paint, checked against a tree made from nothing.
    fn update(&mut self) -> Took {
        let painted = &self.painted;
        let bounds = |id: &str| match painted.get(id) {
            Some(bounds) => *bounds,
            None => Some(at(0.0, 0.0)),
        };
        let facts = Facts {
            title: &self.title,
            bounds: &bounds,
            moved: std::mem::take(&mut self.moved),
            focused: self.focused.as_deref(),
            typed: self.typed.as_deref(),
        };
        let update = self.published.update(&self.document, &facts, &self.targets);
        let took = Took {
            built: update.built,
            sent: update.tree.nodes.len(),
        };
        let focus = update.tree.focus;
        match &mut self.heard {
            Some(heard) => heard.update_and_process_changes(update.tree, &mut Quiet),
            None => self.heard = Some(Tree::new(update.tree, true)),
        }
        let heard = self.heard.as_ref().expect("the tree was just heard");

        let whole_targets = Mutex::default();
        let mut whole = Published::default();
        let whole_update = whole.update(&self.document, &facts, &whole_targets);
        assert_eq!(focus, whole_update.tree.focus, "the focus");
        let whole_nodes = whole_update.tree.nodes.len();
        let expected = Tree::new(whole_update.tree, true);
        let (heard, expected) = (nodes_of(heard), nodes_of(&expected));
        assert_eq!(heard, expected, "what a screen reader has");
        assert_eq!(
            expected.len(),
            whole_nodes,
            "a whole tree is all under the root"
        );
        assert_eq!(self.published.differences(&whole), 0, "what is kept");
        assert_eq!(
            *self.targets.lock().unwrap(),
            *whole_targets.lock().unwrap(),
            "where presses and focus go"
        );
        took
    }

    fn heard(&self, id: NodeId) -> Option<Node> {
        nodes_of(self.heard.as_ref()?).remove(&id.0)
    }
}

const LAUNCHER: &str = r##"{"type":"view","props":{"id":"1"},"children":[
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

fn row(id: &str, selected: bool) -> String {
    format!(
        r#"{{"type":"view","props":{{"id":"{id}","onPress":true,"access":{{"role":"option","selected":{selected}}}}}}}"#
    )
}

fn text(id: &str, words: &str) -> String {
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

/// A long run of every kind of change at once, from a fixed seed.
#[test]
fn any_run_of_changes_keeps_the_tree_whole() {
    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 33) as usize) % n.max(1)
        }
    }
    /// A row: `r{n}` over a text and a layout view with another text.
    #[derive(Clone, Copy)]
    struct Row {
        n: usize,
        selected: bool,
        labelled: bool,
    }
    impl Row {
        fn head(self) -> String {
            let Row {
                n,
                selected,
                labelled,
            } = self;
            let label = if labelled {
                format!(r#","label":"Row {n}""#)
            } else {
                String::new()
            };
            let focusable = n % 3 == 0;
            format!(
                r#"{{"type":"view","props":{{"id":"r{n}","onPress":true,"focusable":{focusable},
                    "access":{{"role":"option","selected":{selected}{label}}}}}"#
            )
        }
        fn whole(self) -> String {
            let n = self.n;
            format!(
                r#"{},"children":[{},{{"type":"view","props":{{"id":"g{n}"}},"children":[{}]}}]}}"#,
                self.head(),
                text(&format!("t{n}"), "one"),
                text(&format!("u{n}"), "two")
            )
        }
    }

    let mut screen = Screen::new(
        r#"{"type":"view","props":{"id":"1"},"children":[
            {"type":"input","props":{"id":"field","value":"","access":{"role":"combobox"}}},
            {"type":"view","props":{"id":"list0","access":{"role":"listbox"}}},
            {"type":"view","props":{"id":"list1"}}
        ]}"#,
    );
    screen.update();
    let mut rng = Rng(7);
    let mut lists: [Vec<Row>; 2] = [Vec::new(), Vec::new()];
    let mut next = 0;
    for step in 0..400 {
        let list = rng.below(2);
        let rows = lists[list].len();
        let at_row = rng.below(rows);
        match rng.below(10) {
            // A row comes.
            0 | 1 => {
                let row = Row {
                    n: next,
                    selected: rng.below(4) == 0,
                    labelled: rng.below(5) == 0,
                };
                next += 1;
                let place = rng.below(rows + 1);
                let before = match lists[list].get(place) {
                    Some(before) => format!(r#","before":"r{}""#, before.n),
                    None => String::new(),
                };
                screen.patch(&format!(
                    r#"{{"op":"insert","parent":"list{list}"{before},"node":{}}}"#,
                    row.whole()
                ));
                lists[list].insert(place, row);
            }
            // One goes.
            2 if rows > 0 => {
                let row = lists[list].remove(at_row);
                screen.patch(&format!(r#"{{"op":"remove","id":"r{}"}}"#, row.n));
            }
            // One moves, within its list or to the other.
            3 if rows > 0 => {
                let row = lists[list].remove(at_row);
                let to = rng.below(2);
                let place = rng.below(lists[to].len() + 1);
                let before = match lists[to].get(place) {
                    Some(before) => format!(r#","before":"r{}""#, before.n),
                    None => String::new(),
                };
                screen.patch(&format!(
                    r#"{{"op":"move","id":"r{}","parent":"list{to}"{before}}}"#,
                    row.n
                ));
                lists[to].insert(place, row);
            }
            // What one says of itself changes.
            4 | 5 if rows > 0 => {
                let row = &mut lists[list][at_row];
                if rng.below(3) == 0 {
                    row.labelled = !row.labelled;
                } else {
                    row.selected = !row.selected;
                }
                screen.patch(&format!(
                    r#"{{"op":"set","id":"r{}","node":{}}}}}"#,
                    row.n,
                    row.head()
                ));
            }
            // Words change, or go.
            6 if rows > 0 => {
                let n = lists[list][at_row].n;
                let id = format!("{}{n}", ["t", "u"][rng.below(2)]);
                let words = ["", "three", "four"][rng.below(3)];
                screen.patch(&format!(
                    r#"{{"op":"set","id":"{id}","node":{}}}"#,
                    text(&id, words)
                ));
            }
            // Bounds move, or a node is no longer painted.
            7 if rows > 0 => {
                let n = lists[list][at_row].n;
                let bounds = (rng.below(4) > 0).then(|| at(0.0, rng.below(500) as f64));
                screen.paint(&format!("r{n}"), bounds);
            }
            // The keyboard moves, or types.
            8 => match rng.below(3) {
                0 => screen.focus(None, None),
                1 => screen.focus(Some("field"), Some(["", "a", "ab"][rng.below(3)])),
                _ if rows > 0 => {
                    let id = format!("r{}", lists[list][at_row].n);
                    screen.focus(Some(&id), None);
                }
                _ => {}
            },
            _ => {}
        }
        // Several changes sometimes land in one update.
        if step % 3 != 0 {
            screen.update();
        }
    }
    screen.update();
    assert!(next > 50, "rows came");
}

#[test]
fn the_driver_names_the_app() {
    assert_eq!(
        app_name(Some("Dashi"), "Launcher").as_deref(),
        Some("Dashi")
    );
    assert_eq!(
        app_name(Some(" Text Editor "), "notes.md").as_deref(),
        Some("Text Editor")
    );
}

#[test]
fn else_the_window_title_but_never_the_host() {
    assert_eq!(app_name(None, "Weather").as_deref(), Some("Weather"));
    assert_eq!(app_name(Some(""), "Weather").as_deref(), Some("Weather"));
    assert_eq!(app_name(None, "mirin metal"), None);
    assert_eq!(app_name(None, "mirin metal (alpha)"), None);
    assert_eq!(app_name(None, "  "), None);
}
