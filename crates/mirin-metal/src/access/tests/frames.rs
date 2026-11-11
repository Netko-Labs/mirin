//! What moves as one is one node: a scroll view's content and the views
//! GPUI keeps the drawing of are frames, and a scroll or a push from above
//! changes the frame and nothing under it. A screen reader finds every node
//! where it was painted all the same (`Screen::update` checks each), and
//! never sees a frame that is only that.

use accesskit::{Node, Role};

use super::screen::{at, Screen, Took};
use crate::access::tree::{node_id, ROOT};

fn button(id: &str) -> String {
    format!(
        r#"{{"type":"view","props":{{"id":"{id}","onPress":true}},"children":[
            {{"type":"text","children":["{id}"]}}]}}"#
    )
}

fn row(id: &str, cards: std::ops::Range<usize>) -> String {
    let cards: Vec<String> = cards.map(|n| button(&format!("card{n}"))).collect();
    format!(
        r#"{{"type":"view","props":{{"id":"{id}"}},"children":[{}]}}"#,
        cards.join(",")
    )
}

/// A page that scrolls: a button, then a grid of rows of cards, then a
/// field; beside it a list that says what it is.
fn page() -> String {
    format!(
        r#"{{"type":"view","props":{{"id":"1"}},"children":[
            {{"type":"view","props":{{"id":"page","scroll":true}},"children":[
                {},
                {{"type":"view","props":{{"id":"grid"}},"children":[{},{},{}]}},
                {{"type":"input","props":{{"id":"field","value":""}}}}
            ]}},
            {{"type":"view","props":{{"id":"list","access":{{"role":"listbox","label":"Results"}}}},
              "children":[{},{}]}}
        ]}}"#,
        button("top"),
        row("row0", 0..3),
        row("row1", 3..6),
        row("row2", 6..9),
        button("opt0"),
        button("opt1"),
    )
}

/// The page laid out: everything somewhere of its own.
fn laid_out(retained: &[&str]) -> Screen {
    let mut screen = Screen::new(&page());
    screen.paint("top", Some(at(0.0, 0.0)));
    screen.paint("grid", Some(at(0.0, 20.0)));
    for row in 0..3 {
        let y = 20.0 + 20.0 * row as f64;
        screen.paint(&format!("row{row}"), Some(at(0.0, y)));
        for card in 0..3 {
            let x = 12.0 * card as f64;
            screen.paint(&format!("card{}", row * 3 + card), Some(at(x, y)));
        }
    }
    screen.paint("field", Some(at(0.0, 90.0)));
    screen.paint("list", Some(at(200.0, 0.0)));
    screen.paint("opt0", Some(at(200.0, 0.0)));
    screen.paint("opt1", Some(at(200.0, 12.0)));
    for id in retained {
        screen.retain(id, true);
    }
    screen
}

fn is_frame(node: &Node) -> bool {
    node.role() == Role::GenericContainer && node.transform().is_some()
}

#[test]
fn a_scroll_is_the_contents_frame_alone() {
    let mut screen = laid_out(&[]);
    screen.update();
    assert!(is_frame(&screen.heard(node_id("page")).unwrap()));

    // Every card, the button and the field moved; only the content did.
    screen.scroll("page", -40.0);
    assert_eq!(screen.update(), Took { built: 1, sent: 1 });
    screen.scroll("page", 15.0);
    assert_eq!(screen.update().sent, 1);

    // The list beside it is no part of it.
    assert_eq!(screen.update().sent, 0, "nothing moved");
}

#[test]
fn kept_drawings_move_as_one() {
    let mut screen = laid_out(&["grid", "row0", "row1", "row2", "list"]);
    screen.update();
    assert!(is_frame(&screen.heard(node_id("grid")).unwrap()));
    assert!(is_frame(&screen.heard(node_id("row1")).unwrap()));

    // The button above the grid grew: the grid moved down, as it was drawn.
    screen.push("grid", 30.0);
    screen.push("field", 30.0);
    // The grid's frame, and the field (in no kept drawing).
    assert_eq!(screen.update().sent, 2);

    // One row grew: the row under it moved in the grid, which is drawn anew.
    screen.push("row2", 5.0);
    assert_eq!(screen.update().sent, 1, "the row's frame");

    // A scroll on top of it all.
    screen.scroll("page", -25.0);
    assert_eq!(screen.update().sent, 1);

    // The list says what it is and is kept: its own node is the frame, and
    // moves with what is in it.
    let list = screen.heard(node_id("list")).unwrap();
    assert_eq!(list.role(), Role::ListBox);
    assert!(list.transform().is_some());
    screen.push("list", 7.0);
    assert_eq!(screen.update().sent, 1);

    // One card on its own: that card.
    screen.paint("card4", Some(at(50.0, 50.0)));
    assert_eq!(screen.update().sent, 1);
    // And no longer painted.
    screen.paint("card4", None);
    assert_eq!(screen.update().sent, 1);
    assert_eq!(screen.heard(node_id("card4")).unwrap().bounds(), None);
}

#[test]
fn a_frame_is_nothing_a_screen_reader_reads() {
    let mut plain = laid_out(&[]);
    let mut framed = laid_out(&["grid", "row0", "row1", "row2", "list"]);
    plain.update();
    framed.update();
    assert_eq!(plain.outline(), framed.outline());
    assert!(plain.outline().len() > 12);
    assert!(
        plain.outline().iter().all(|line| !line.contains("Generic")),
        "frames are left out"
    );
    // The rows are the window's children still, in order, through the frames.
    let top = framed.heard(ROOT).unwrap().children().len();
    assert_eq!(top, 2, "the page's frame and the list");

    for screen in [&mut plain, &mut framed] {
        screen.scroll("page", -30.0);
        screen.update();
        screen.push("grid", 12.0);
        screen.patch(&format!(
            r#"{{"op":"insert","parent":"row1","node":{}}}"#,
            button("late")
        ));
        screen.paint("late", Some(at(40.0, 70.0)));
        screen.update();
    }
    assert_eq!(plain.outline(), framed.outline());
}

#[test]
fn a_view_with_nothing_placed_under_it_is_no_frame() {
    // Kept, but all words: nothing under it has a place to move.
    let mut screen = Screen::new(
        r#"{"type":"view","props":{"id":"1"},"children":[
            {"type":"view","props":{"id":"words"},"children":[
                {"type":"text","children":["one"]},{"type":"text","children":["two"]}]},
            {"type":"view","props":{"id":"ok","onPress":true},"children":[
                {"type":"text","children":["OK"]}]}
        ]}"#,
    );
    screen.retain("words", true);
    screen.retain("ok", true);
    screen.update();
    assert!(screen.heard(node_id("words")).is_none());
    let ok = screen.heard(node_id("ok")).unwrap();
    assert_eq!(ok.role(), Role::Button);
    assert!(ok.transform().is_none(), "its text has no place of its own");
    assert_eq!(ok.bounds(), Some(at(0.0, 0.0)));
}

#[test]
fn frames_come_and_go_with_what_is_kept() {
    let mut screen = laid_out(&["grid"]);
    screen.update();
    // A row grows a card and is kept from now on.
    let late = |id: &str| format!(r#"{{"op":"insert","parent":"row1","node":{}}}"#, button(id));
    screen.patch(&late("late"));
    screen.retain("row1", true);
    screen.paint("card3", Some(at(1.0, 41.0)));
    screen.update();
    assert!(is_frame(&screen.heard(node_id("row1")).unwrap()));
    // The grid no longer (something in it stops it).
    screen.patch(
        r#"{"op":"set","id":"grid","node":{"type":"view","props":{"id":"grid","focusable":true}}}"#,
    );
    screen.retain("grid", false);
    screen.update();
    assert_eq!(screen.heard(node_id("grid")).unwrap().role(), Role::Group);
    screen.scroll("page", 9.0);
    assert_eq!(screen.update().sent, 1);
    // Nor the row: its cards are the grid's again.
    screen.patch(r#"{"op":"remove","id":"late"}"#);
    screen.retain("row1", false);
    screen.update();
    assert!(screen.heard(node_id("row1")).is_none());
}

#[test]
fn a_frame_not_painted_yet_places_by_the_window() {
    let mut screen = laid_out(&["grid", "row1"]);
    // The grid's own bounds were never recorded (a scroll view's child has
    // none), so no drawing of it is known; what is in it is.
    screen.paint("grid", None);
    screen.update();
    screen.scroll("page", -10.0);
    screen.update();
    screen.push("row1", 4.0);
    screen.update();
    // Painted: the frame is where the grid is.
    screen.paint("grid", Some(at(0.0, 20.0)));
    screen.update();
    screen.scroll("page", -10.0);
    assert_eq!(screen.update().sent, 1);
}
