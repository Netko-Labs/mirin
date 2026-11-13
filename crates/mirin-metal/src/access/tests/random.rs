//! A long run of every kind of change at once: after each update the tree
//! a screen reader has is the one made from nothing, and every node is
//! where it was painted.

use super::changes::text;
use super::screen::{at, Screen};

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
    /// A row: `r{n}` over a text and a layout view with another text (and a
    /// button, in every other row).
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
            // Every other row has a button in its inner view: a node with
            // a place under two views that may be frames.
            let button = match n % 2 {
                0 => format!(r#",{{"type":"view","props":{{"id":"b{n}","onPress":true}}}}"#),
                _ => String::new(),
            };
            format!(
                r#"{},"children":[{},{{"type":"view","props":{{"id":"g{n}"}},"children":[{}{button}]}}]}}"#,
                self.head(),
                text(&format!("t{n}"), "one"),
                text(&format!("u{n}"), "two")
            )
        }
    }

    // The second list is in a view that scrolls.
    let mut screen = Screen::new(
        r#"{"type":"view","props":{"id":"1"},"children":[
            {"type":"input","props":{"id":"field","value":"","access":{"role":"combobox"}}},
            {"type":"view","props":{"id":"list0","access":{"role":"listbox"}}},
            {"type":"view","props":{"id":"page","scroll":true},"children":[
                {"type":"view","props":{"id":"list1"}}
            ]}
        ]}"#,
    );
    screen.update();
    let mut rng = Rng(7);
    let mut lists: [Vec<Row>; 2] = [Vec::new(), Vec::new()];
    let mut next = 0;
    let mut frames = 0;
    for step in 0..1200 {
        let list = rng.below(2);
        let rows = lists[list].len();
        let at_row = rng.below(rows);
        match rng.below(14) {
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
            // The page scrolls.
            9 => screen.scroll("page", rng.below(60) as f64 - 30.0),
            // A list or a row is pushed from above, as it is.
            10 => {
                let dy = rng.below(40) as f64 - 10.0;
                match lists[list].get(at_row) {
                    Some(row) if rng.below(3) > 0 => screen.push(&format!("r{}", row.n), dy),
                    _ => screen.push(&format!("list{list}"), dy),
                }
            }
            // GPUI keeps the drawing of a list, a row, or the view in a
            // row, or no longer does: with a patch that reaches it.
            11 | 12 => {
                let row = lists[list].get(at_row).copied();
                let (id, node) = match (rng.below(4), row) {
                    (0, _) | (_, None) => {
                        let role = ["", r#","access":{"role":"listbox"}"#][1 - list];
                        let props = format!(r#"{{"id":"list{list}"{role}}}"#);
                        let node = format!(r#"{{"type":"view","props":{props}}}"#);
                        (format!("list{list}"), node)
                    }
                    (1, Some(row)) => {
                        let id = format!("g{}", row.n);
                        let node = format!(r#"{{"type":"view","props":{{"id":"{id}"}}}}"#);
                        (id, node)
                    }
                    (_, Some(row)) => (format!("r{}", row.n), format!("{}}}", row.head())),
                };
                screen.patch(&format!(r#"{{"op":"set","id":"{id}","node":{node}}}"#));
                screen.retain(&id, rng.below(3) > 0);
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
            frames = frames.max(screen.frames());
        }
    }
    screen.update();
    assert!(next > 50, "rows came");
    assert!(frames > 5, "and were frames, in frames");
}
