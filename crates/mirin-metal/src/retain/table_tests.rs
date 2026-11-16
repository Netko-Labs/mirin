//! A table that re-sorts, shaped as Dashi's Activity Monitor sends it: rows
//! that hear the pointer (so they are never left out), each a name cell
//! with the name inside it, both retained subtrees of their own, and figure
//! cells too small to be one, in a scroll view that hears hovers (so it is
//! a plain scroll view, not a virtualized list). Every frame must draw what
//! a window opened on the same tree draws.

use sumi::{px, size, Entity, TestAppContext, VisualTestContext};

use crate::events::EventSender;
use crate::patch::{Document, PatchOp};
use crate::sim::LayoutMap;
use crate::tree::{parse_tree, NodeSpec};
use crate::window::RootView;

/// One row: its name cell (a chevron's or a spacer's place, an icon's, the
/// name) and two figure cells. The test platform lays text out but draws
/// no glyphs, so the name stands on a ground of its own colour: where that
/// is drawn is where the name is.
fn row(pid: usize, figure: usize, striped: bool) -> String {
    let text = |id: &str, words: &str| {
        format!(
            r##"{{"type":"view","props":{{"id":"{id}","direction":"row","paddingX":5,"width":72,"shrink":false,"align":"center","justify":"end"}},"children":[{}]}}"##,
            figure_text(&format!("{id}t"), words)
        )
    };
    let name = format!("#{:06x}", (pid * 2_654_435 + 0x12_3456) & 0xff_ffff);
    format!(
        r##"{}"children":[
          {{"type":"view","props":{{"id":"c{pid}","direction":"row","paddingX":5,"minWidth":0,"flex":1,"align":"center","justify":"start"}},"children":[
            {{"type":"view","props":{{"id":"n{pid}","direction":"row","gap":5,"paddingLeft":0,"minWidth":0,"flex":1,"align":"center"}},"children":[
              {{"type":"view","props":{{"id":"s{pid}","width":14,"shrink":false}}}},
              {{"type":"view","props":{{"id":"i{pid}","width":16,"height":16,"shrink":false}}}},
              {{"type":"view","props":{{"id":"w{pid}","minWidth":0,"shrink":true,"width":60,"height":14,"background":"{name}"}},"children":[
                {{"type":"text","props":{{"color":"#1d1d1f","size":12,"truncate":true}},"children":["process {pid}"]}}]}}]}}]}},
          {},{}]}}"##,
        row_props(pid, striped).trim_end_matches('}'),
        text(&format!("m{pid}"), &format!("{figure} MB")),
        text(&format!("p{pid}"), &pid.to_string()),
    )
}

/// A row's own node, without its children: `{"type":"view","props":{…}}`.
fn row_props(pid: usize, striped: bool) -> String {
    let ground = if striped { "#f5f5f7" } else { "#00000000" };
    format!(
        r##"{{"type":"view","props":{{"id":"r{pid}","direction":"row","height":24,"shrink":false,"background":"{ground}","cornerRadius":5,"onPointer":true,"onPress":true,"onHover":true}},}}"##
    )
}

fn figure_text(id: &str, words: &str) -> String {
    format!(
        r##"{{"type":"text","props":{{"id":"{id}","color":"#1d1d1f","size":12,"truncate":true,"align":"right"}},"children":["{words}"]}}"##
    )
}

/// The rows' order: by figure, largest first.
fn order(figures: &[usize]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..figures.len()).collect();
    order.sort_by_key(|&pid| std::cmp::Reverse((figures[pid], pid)));
    order
}

/// What a patching driver sends to go from `before` to `after`: each
/// figure's text, then the rows moved into their new order (React's
/// reconciler: a row found before the last one that stayed is moved, in
/// front of the next row that stays).
fn patch(before: &[usize], after: &[usize]) -> Vec<PatchOp> {
    let mut ops: Vec<PatchOp> = (0..after.len())
        .filter(|&pid| before[pid] != after[pid])
        .map(|pid| PatchOp::Set {
            id: format!("m{pid}t"),
            node: Box::new(
                parse_tree(&figure_text(
                    &format!("m{pid}t"),
                    &format!("{} MB", after[pid]),
                ))
                .expect("text parses"),
            ),
        })
        .collect();
    let (old, new) = (order(before), order(after));
    // Each row whose place changed between odd and even gets its ground.
    for (index, &pid) in new.iter().enumerate() {
        let was = old.iter().position(|&each| each == pid).unwrap_or(0);
        if was % 2 != index % 2 {
            let mut props = row_props(pid, index % 2 == 1);
            props = props.replacen(",}", "}", 1);
            ops.push(PatchOp::Set {
                id: format!("r{pid}"),
                node: Box::new(parse_tree(&props).expect("row props parse")),
            });
        }
    }
    let place = |pid: usize| old.iter().position(|&each| each == pid).unwrap_or(0);
    let mut moved = vec![false; new.len()];
    let mut last = 0;
    for (index, &pid) in new.iter().enumerate() {
        if index > 0 && place(pid) < last {
            moved[index] = true;
        } else {
            last = place(pid);
        }
    }
    for (index, &pid) in new.iter().enumerate().filter(|&(index, _)| moved[index]) {
        let next = (index + 1..new.len()).find(|&after| !moved[after]);
        ops.push(PatchOp::Move {
            id: format!("r{pid}"),
            parent: "rows".into(),
            before: next.map(|after| format!("r{}", new[after])),
        });
    }
    ops
}

/// `rows` processes, by `figure` of each from largest down: `figures[pid]`.
fn table(figures: &[usize]) -> NodeSpec {
    let rows: Vec<String> = order(figures)
        .iter()
        .enumerate()
        .map(|(index, &pid)| row(pid, figures[pid], index % 2 == 1))
        .collect();
    let json = format!(
        r#"{{"type":"view","props":{{"id":"root","fill":true}},"children":[
          {{"type":"view","props":{{"id":"head","height":26}}}},
          {{"type":"view","props":{{"id":"rows","direction":"column","paddingX":5,"paddingBottom":8,"flex":1,"scroll":true,"onHover":true}},"children":[{}]}}]}}"#,
        rows.join(",")
    );
    parse_tree(&json).expect("test tree must parse")
}

fn open(
    cx: &mut TestAppContext,
    tree: NodeSpec,
    scale: f32,
) -> (Entity<RootView>, &mut VisualTestContext) {
    let (tx, _rx) = std::sync::mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let (view, cx) = cx.add_window_view(move |_, cx| {
        RootView::new(Document::new(tree), false, events, layout, cx)
    });
    cx.simulate_scale_factor_change(scale);
    cx.simulate_resize(size(px(600.0), px(400.0)));
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

/// What the last frame drew, but the scroll bar (shown for a while after the
/// content changes, so not in a window that was only opened).
fn drawn(cx: &mut VisualTestContext) -> Vec<String> {
    let bar = |each: &String| {
        each.contains("a: 0.5647059")
            || each.starts_with("Hitbox Bounds { origin: Point { x: 586px")
    };
    cx.update(|window, _| {
        window
            .last_scene_drawn()
            .into_iter()
            .filter(|each| !bar(each))
            .collect()
    })
}

fn assert_same(kept: &[String], fresh: &[String], what: &str) {
    if kept != fresh {
        let only = |a: &[String], b: &[String]| {
            a.iter()
                .filter(|each| !b.contains(each))
                .take(4)
                .cloned()
                .collect::<Vec<_>>()
        };
        panic!(
            "{what}: {} drawn, {} fresh\nonly drawn: {:#?}\nonly fresh: {:#?}",
            kept.len(),
            fresh.len(),
            only(kept, fresh),
            only(fresh, kept),
        );
    }
}

/// A figure cell's box, `width` wide, without its text: what a patch sets
/// when a column's width changes.
fn figure_box(id: &str, width: f32) -> NodeSpec {
    parse_tree(&format!(
        r#"{{"type":"view","props":{{"id":"{id}","direction":"row","paddingX":5,"width":{width},"shrink":false,"align":"center","justify":"end"}}}}"#
    ))
    .expect("a figure cell parses")
}

/// A row's name cell is left out (parked) as the row sorts just out of
/// view; the row is then copied two rows lower, still out of view; then it
/// sorts back into view with a wider column, so its cell is drawn again and
/// the name in it copied from where it was parked. The copy of the row
/// used to move the name's record but not its parked drawing, so the name
/// came back two rows away from its row, over another's (Dashi's Activity
/// Monitor re-sorting while it scrolled). At 1.75 this table's rows are
/// drawn anew rather than copied (what their texts round to is not a whole
/// move there), so it runs where scaling is exact.
fn parked_name_follows_its_row(cx: &mut TestAppContext, scale: f32) {
    // Thirty rows in a list that shows fifteen and a half: the row at 16 is
    // just out of view. Process 2's row is the one followed.
    const ROWS: usize = 30;
    let base: Vec<usize> = (0..ROWS).map(|pid| 1000 - pid * 10).collect();
    let mut steps: Vec<Vec<usize>> = vec![base.clone()];
    // 1. It changes and sorts to 16: drawn anew, its name cell left out (parked).
    let mut figures = base.clone();
    figures[2] = 835;
    steps.push(figures.clone());
    // 2. Processes 25 and 26 jump to the top: the row, unchanged (two rows
    //    down keep its stripe), is copied two rows lower, still out of view,
    //    its name cell still parked.
    figures[25] = 2000;
    figures[26] = 1990;
    steps.push(figures.clone());
    // 3. It changes, sorts to 1, and its figure column widens: drawn anew in
    //    view, its name cell drawn again on its new width, the name in it
    //    copied from where it was parked.
    figures[2] = 1500;
    steps.push(figures.clone());

    let (view, window) = open(cx, table(&steps[0]), scale);
    let mut kept = Vec::new();
    for (step, pair) in steps.windows(2).enumerate() {
        let mut ops = patch(&pair[0], &pair[1]);
        if step == 2 {
            ops.push(PatchOp::Set {
                id: "m2".into(),
                node: Box::new(figure_box("m2", 150.0)),
            });
        }
        window.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.apply_patch(ops, cx).expect("the patch applies")
            })
        });
        draw(window);
        let tree = window.update(|_, cx| (**view.read(cx).tree.tree()).clone());
        kept.push((drawn(window), tree));
    }
    for (step, (kept, tree)) in kept.iter().enumerate() {
        let (_fresh_view, fresh) = open(cx, tree.clone(), scale);
        assert_same(
            kept,
            &drawn(fresh),
            &format!("step {} at scale {scale}", step + 1),
        );
    }
}

#[sumi::test]
fn a_name_parked_in_its_cell_stays_with_its_row_when_the_row_moves_out_of_view(
    cx: &mut TestAppContext,
) {
    parked_name_follows_its_row(cx, 1.0);
}

#[sumi::test]
fn a_name_parked_in_its_cell_stays_with_its_row_at_2(cx: &mut TestAppContext) {
    parked_name_follows_its_row(cx, 2.0);
}
