//! A scroll view's offset told to the driver and set by it, on GPUI's test
//! platform: a page of rows in a scroll view, and one long enough to be a
//! virtualized list.

use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use sumi::{point, px, size, Entity, ScrollDelta, TestAppContext, VisualTestContext};

use super::{nearest, wait, Reporter, Reports, ScrollCommand, ScrollPosition};
use crate::events::{EventKind, EventSender, NativeUiEvent};
use crate::patch::Document;
use crate::sim::{LayoutMap, LayoutNode};
use crate::tree::parse_tree;
use crate::window::RootView;

/// `rows` rows 40 tall in a scroll view 200 tall, under a bar 50 tall, in a
/// window 400 wide: the view shows five rows.
fn page(rows: usize, props: &str) -> String {
    let rows: Vec<String> = (0..rows)
        .map(|row| format!(r#"{{"type":"view","props":{{"id":"row{row}","height":40}}}}"#))
        .collect();
    format!(
        r#"{{"type":"view","props":{{"id":"root","fill":true}},"children":[
          {{"type":"view","props":{{"id":"bar","height":50}}}},
          {{"type":"view","props":{{"id":"rows","height":200,"scroll":true{props}}},"children":[{}]}}]}}"#,
        rows.join(",")
    )
}

struct Page {
    view: Entity<RootView>,
    events: Receiver<NativeUiEvent>,
}

fn open<'a>(cx: &'a mut TestAppContext, json: &str) -> (Page, &'a mut VisualTestContext) {
    let tree = parse_tree(json).expect("test tree must parse");
    let (tx, events) = channel();
    let layout = LayoutMap::default();
    let sender = EventSender::new(tx, layout.clone());
    let (view, cx) = cx.add_window_view(move |_, cx| {
        RootView::new(Document::new(tree), false, sender, layout, cx)
    });
    cx.simulate_resize(size(px(400.0), px(300.0)));
    cx.run_until_parked();
    draw(cx);
    (Page { view, events }, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

impl Page {
    /// The `scroll` events since last asked, oldest first.
    fn told(&self) -> Vec<ScrollPosition> {
        self.events
            .try_iter()
            .filter_map(|event| match event.kind {
                EventKind::Scroll(position) => Some(position),
                _ => None,
            })
            .collect()
    }

    /// The driver's line, then the frames it takes to show.
    fn ask(&self, cx: &mut VisualTestContext, command: ScrollCommand) {
        cx.update(|_, cx| self.view.update(cx, |view, cx| view.scroll(command, cx)));
        for _ in 0..4 {
            draw(cx);
        }
    }

    fn to(&self, cx: &mut VisualTestContext, y: f32) {
        self.ask(
            cx,
            ScrollCommand::To {
                id: "rows".into(),
                x: None,
                y: Some(y),
            },
        );
    }

    fn show(&self, cx: &mut VisualTestContext, id: &str) {
        self.ask(cx, ScrollCommand::IntoView { id: id.into() });
    }

    fn painted(&self, cx: &mut VisualTestContext, id: &str) -> Option<LayoutNode> {
        cx.update(|_, cx| self.view.read(cx).layout.node(id))
    }

    /// Where row `row` is painted: its top and bottom in the window.
    fn row(&self, cx: &mut VisualTestContext, row: usize) -> (f32, f32) {
        let node = self
            .painted(cx, &format!("row{row}"))
            .expect("the row is painted");
        (node.y, node.y + node.height)
    }
}

fn wheel(cx: &mut VisualTestContext, dy: f32) {
    cx.simulate_event(sumi::ScrollEvent {
        position: point(px(100.0), px(150.0)),
        delta: ScrollDelta::Pixels(point(px(0.0), px(-dy))),
        ..Default::default()
    });
}

#[sumi::test]
fn a_scroll_view_tells_where_it_stands_whoever_moved_it(cx: &mut TestAppContext) {
    let (page, cx) = open(cx, &page(20, r#","onScroll":true"#));
    // Nothing to tell of a view at its start.
    assert!(page.told().is_empty());
    // The wheel.
    wheel(cx, 60.0);
    draw(cx);
    assert_eq!(
        page.told(),
        [ScrollPosition {
            x: 0.0,
            y: 60.0,
            content_width: 400.0,
            content_height: 800.0,
            width: 400.0,
            height: 200.0,
        }]
    );
    // A frame that scrolls nothing tells nothing.
    draw(cx);
    assert!(page.told().is_empty());
    // The driver, and the view keeps what it asks in its range.
    page.to(cx, 240.5);
    assert_eq!(page.told().last().map(|told| told.y), Some(240.5));
    page.to(cx, 5000.0);
    assert_eq!(page.told().last().map(|told| told.y), Some(600.0));
    page.to(cx, -20.0);
    assert_eq!(page.told().last().map(|told| told.y), Some(0.0));
}

#[sumi::test]
fn a_view_that_does_not_listen_says_nothing_and_one_that_starts_says_where_it_is(
    cx: &mut TestAppContext,
) {
    let (page, cx) = open(cx, &page(20, ""));
    page.to(cx, 120.0);
    assert!(page.told().is_empty());
    assert_eq!(page.row(cx, 3).0, 50.0);
    // The driver starts listening: it hears where the view stands.
    let listening = parse_tree(&self::page(20, r#","onScroll":true"#)).expect("tree");
    cx.update(|_, cx| {
        page.view
            .update(cx, |view, cx| view.set_tree(listening, cx))
    });
    draw(cx);
    assert_eq!(page.told().last().map(|told| told.y), Some(120.0));
}

#[sumi::test]
fn a_node_asked_into_view_is_shown_by_the_least_scroll(cx: &mut TestAppContext) {
    let (page, cx) = open(cx, &page(20, r#","onScroll":true"#));
    // The view shows y 50 to 250. Row 9 is below it: it comes to the bottom edge.
    page.show(cx, "row9");
    assert_eq!(page.row(cx, 9), (210.0, 250.0));
    assert_eq!(page.told().last().map(|told| told.y), Some(200.0));
    // A row that shows whole moves nothing.
    page.show(cx, "row7");
    assert_eq!(page.row(cx, 9), (210.0, 250.0));
    assert!(page.told().is_empty());
    // Row 2 is above: it comes to the top edge.
    page.show(cx, "row2");
    assert_eq!(page.row(cx, 2), (50.0, 90.0));
    // The last row, and the view ends there.
    page.show(cx, "row19");
    assert_eq!(page.row(cx, 19), (210.0, 250.0));
    assert_eq!(page.told().last().map(|told| told.y), Some(600.0));
}

#[sumi::test]
fn a_node_that_came_with_the_newest_tree_is_shown_once_it_is_drawn(cx: &mut TestAppContext) {
    let (page, cx) = open(cx, &page(6, ""));
    // The tree grows and its new last row is asked for in the same turn.
    let grown = parse_tree(&self::page(30, "")).expect("tree");
    cx.update(|_, cx| {
        page.view.update(cx, |view, cx| {
            view.set_tree(grown, cx);
            view.scroll(ScrollCommand::IntoView { id: "row29".into() }, cx);
        });
    });
    for _ in 0..4 {
        draw(cx);
    }
    assert_eq!(page.row(cx, 29), (210.0, 250.0));
}

#[sumi::test]
fn a_view_inside_a_scroll_view_scrolls_both(cx: &mut TestAppContext) {
    let inner: Vec<String> = (0..10)
        .map(|row| format!(r#"{{"type":"view","props":{{"id":"in{row}","height":40}}}}"#))
        .collect();
    let json = format!(
        r#"{{"type":"view","props":{{"id":"root","fill":true}},"children":[
          {{"type":"view","props":{{"id":"outer","height":200,"scroll":true}},"children":[
            {{"type":"view","props":{{"id":"above","height":300}}}},
            {{"type":"view","props":{{"id":"inner","height":120,"scroll":true}},"children":[{}]}},
            {{"type":"view","props":{{"id":"below","height":300}}}}]}}]}}"#,
        inner.join(",")
    );
    let (page, cx) = open(cx, &json);
    page.show(cx, "in9");
    let row = page.painted(cx, "in9").expect("painted");
    let inner = page.painted(cx, "inner").expect("painted");
    // At the inner view's bottom edge, which is at the outer one's.
    assert_eq!(row.y + row.height, inner.y + inner.height);
    assert_eq!(inner.y + inner.height, 200.0);
}

#[sumi::test]
fn a_virtualized_list_tells_its_offset_and_brings_a_row_in_by_index(cx: &mut TestAppContext) {
    let (page, cx) = open(cx, &page(300, r#","onScroll":true"#));
    cx.update(|_, cx| assert!(page.view.read(cx).lists.contains_key("rows")));
    wheel(cx, 100.0);
    draw(cx);
    assert_eq!(page.told().last().map(|told| told.y), Some(100.0));
    // A row far below is not laid out yet.
    assert!(page.painted(cx, "row250").is_none());
    page.show(cx, "row250");
    assert_eq!(page.row(cx, 250), (210.0, 250.0));
    // Its offset counts the rows it never laid out, at the height of those it has.
    assert_eq!(
        page.told().last().map(|told| (told.y, told.content_height)),
        Some((9840.0, 12000.0))
    );
    // And back up, to one above what shows.
    page.show(cx, "row100");
    assert_eq!(page.row(cx, 100), (50.0, 90.0));
    assert_eq!(page.told().last().map(|told| told.y), Some(4000.0));
    // To an offset: rows 5 to 9 show.
    page.to(cx, 200.0);
    assert_eq!(page.row(cx, 5), (50.0, 90.0));
    assert_eq!(page.told().last().map(|told| told.y), Some(200.0));
}

#[sumi::test]
fn a_list_nobody_scrolls_or_listens_to_counts_only_the_rows_it_has_laid_out(
    cx: &mut TestAppContext,
) {
    // As it always has: its bar and its range grow as a person scrolls.
    let (page, cx) = open(cx, &page(300, ""));
    let length = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let list = &page.view.read(cx).lists["rows"];
            f32::from(list.state.max_offset_for_scrollbar().y)
        })
    };
    let before = length(cx);
    assert!(before < 2000.0, "{before}");
    // The driver sends it to an offset: every row counts from here on.
    page.to(cx, 4000.0);
    assert_eq!(length(cx), 11800.0);
    assert_eq!(page.row(cx, 100), (50.0, 90.0));
}

#[test]
fn a_node_scrolls_the_least_that_shows_it_whole() {
    // In view: nothing.
    assert_eq!(nearest(60.0, 100.0, 50.0, 250.0), 0.0);
    // Above: back to its start. Below: on to its end.
    assert_eq!(nearest(10.0, 50.0, 50.0, 250.0), -40.0);
    assert_eq!(nearest(240.0, 280.0, 50.0, 250.0), 30.0);
    // Longer than the view and below it: to its start, not past it.
    assert_eq!(nearest(100.0, 400.0, 50.0, 250.0), 50.0);
    // Filling the view: nothing to gain.
    assert_eq!(nearest(0.0, 400.0, 50.0, 250.0), 0.0);
}

#[test]
fn reports_wait_out_their_throttle_and_the_last_offset_is_told() {
    let ms = Duration::from_millis;
    let start = Instant::now();
    assert_eq!(wait(start, None, ms(100)), None);
    assert_eq!(wait(start + ms(40), Some(start), ms(100)), Some(ms(60)));
    assert_eq!(wait(start + ms(100), Some(start), ms(100)), None);
    assert_eq!(wait(start + ms(5), Some(start), ms(0)), None);

    let (tx, events) = channel();
    let reporter = Reporter {
        id: "rows".into(),
        events: EventSender::new(tx, LayoutMap::default()),
        throttle: ms(100),
        reports: Reports::default(),
    };
    let at = |y: f32| ScrollPosition {
        x: 0.0,
        y,
        content_width: 400.0,
        content_height: 800.0,
        width: 400.0,
        height: 200.0,
    };
    let told = || -> Vec<f32> {
        events
            .try_iter()
            .filter_map(|event| match event.kind {
                EventKind::Scroll(position) => Some(position.y),
                _ => None,
            })
            .collect()
    };
    // The first move is told at once.
    assert_eq!(reporter.tell(at(10.0), start), None);
    assert_eq!(told(), [10.0]);
    // A fling's frames: none is told, and one timer is asked for, for what is left.
    assert_eq!(reporter.tell(at(20.0), start + ms(16)), Some(ms(84)));
    assert_eq!(reporter.tell(at(30.0), start + ms(32)), None);
    assert_eq!(reporter.tell(at(40.0), start + ms(48)), None);
    assert!(told().is_empty());
    // The timer fires: where the view is then.
    reporter.reports.0.borrow_mut().waits = false;
    assert_eq!(reporter.tell(at(40.0), start + ms(100)), None);
    assert_eq!(told(), [40.0]);
    // Back where the driver last heard: nothing to tell, however long after.
    assert_eq!(reporter.tell(at(40.0), start + ms(500)), None);
    assert!(told().is_empty());
}
