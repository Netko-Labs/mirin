//! The layout map: what is painted where, what left, and which places it
//! says changed.

mod old;

use std::collections::{BTreeMap, BTreeSet};

use gpui::{point, px, size, Bounds, Pixels};

use super::{Frame, LayoutMap, Placed};
use old::OldMap;

fn at(x: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(x), px(0.)), size(px(10.), px(10.)))
}

#[test]
fn the_revision_moves_only_when_places_do() {
    let layout = LayoutMap::default();
    layout.begin_frame();
    layout.record("a", at(0.), None);
    let first = layout.revision();
    layout.begin_frame();
    layout.record("a", at(0.), None);
    layout.end_frame();
    assert_eq!(layout.revision(), first, "the same bounds again");
    layout.begin_frame();
    layout.record("a", at(5.), None);
    assert!(layout.revision() > first, "a resize moved it");
    let moved = layout.revision();
    layout.begin_frame();
    layout.end_frame();
    assert!(
        layout.revision() > moved,
        "a node no longer painted is forgotten"
    );
    assert!(layout.node("a").is_none());
}

/// A retained subtree whose drawing is reused records nothing, and its
/// nodes (and those of the subtrees inside it) are still painted.
#[test]
fn a_reused_subtree_keeps_its_nodes_painted() {
    let layout = LayoutMap::default();
    // Frame 1: row (group 1) and the card inside it (group 2) drawn anew.
    layout.begin_frame();
    layout.touch_group(1, None, at(0.).origin, true);
    layout.record("card", at(0.), Some(1));
    layout.touch_group(2, Some(1), at(1.).origin, true);
    layout.record("text", at(1.), Some(2));
    layout.end_frame();
    let drawn = layout.revision();
    // Frame 2: the row is reused; nothing inside runs.
    layout.begin_frame();
    layout.touch_group(1, None, at(0.).origin, false);
    layout.end_frame();
    assert!(layout.node("card").is_some());
    assert!(layout.node("text").is_some(), "inside a reused subtree");
    assert_eq!(layout.revision(), drawn, "and nothing moved");
    // Frame 3: the row is drawn anew without the card's subtree.
    layout.begin_frame();
    layout.touch_group(1, None, at(0.).origin, true);
    layout.record("card", at(0.), Some(1));
    layout.end_frame();
    assert!(layout.node("card").is_some());
    assert!(layout.node("text").is_none(), "left the row");
    assert_eq!(layout.revision(), drawn + 2, "the text and its group left");
    // Frame 4: the row is gone.
    layout.begin_frame();
    layout.end_frame();
    assert!(layout.node("card").is_none());
}

/// A retained subtree whose drawing is copied elsewhere (it scrolled), or
/// left out, records nothing: its nodes, and those of the subtrees inside
/// it, are where it is now, and only its own place changed.
#[test]
fn a_moved_subtree_takes_its_nodes_along() {
    let layout = LayoutMap::default();
    let x = |id: &str| layout.node(id).map(|node| node.x);
    // Frame 1: the row (group 1) at 10 with a card inside it, and the
    // card's subtree (group 2) at 12 with a text inside that.
    layout.begin_frame();
    layout.touch_group(1, None, at(10.).origin, true);
    layout.record("card", at(12.), Some(1));
    layout.touch_group(2, Some(1), at(12.).origin, true);
    layout.record("text", at(13.), Some(2));
    assert!(layout.take_changes().is_none(), "nobody asked before");
    // Frame 2: the row's drawing is copied 5 further; nothing inside runs.
    layout.begin_frame();
    layout.touch_group(1, None, at(15.).origin, false);
    layout.end_frame();
    assert_eq!(x("card"), Some(17.));
    assert_eq!(x("text"), Some(18.), "inside a subtree carried along");
    let changes = layout.take_changes().unwrap();
    assert_eq!(changes.groups, [1], "the row's place");
    assert!(changes.nodes.is_empty(), "nothing in it moved in it");
    let card = layout.placed("card").unwrap();
    assert_eq!((card.rect[0], card.group), (2., Some(1)));
    let inner = layout.frame(2).unwrap();
    assert_eq!((inner.offset, inner.parent), ((2., 0.), Some(1)));
    assert_eq!(layout.origin(2), Some((17., 0.)));
    // Frame 3: left out, 100 further.
    layout.begin_frame();
    layout.touch_group(1, None, at(115.).origin, false);
    assert_eq!(x("text"), Some(118.));
    // Frame 4: where it was: nothing changed.
    layout.begin_frame();
    layout.take_changes();
    layout.touch_group(1, None, at(115.).origin, false);
    layout.end_frame();
    assert!(layout.take_changes().unwrap().is_empty());
    // Frame 5: the row is drawn anew at 40 (its card recorded again), and
    // the card's subtree is copied to where it now is.
    layout.begin_frame();
    layout.touch_group(1, None, at(40.).origin, true);
    layout.record("card", at(42.), Some(1));
    layout.touch_group(2, Some(1), at(42.).origin, false);
    layout.end_frame();
    assert_eq!(x("card"), Some(42.));
    assert_eq!(x("text"), Some(43.));
    let changes = layout.take_changes().unwrap();
    assert_eq!(changes.groups, [1], "all as it was in the row");
    assert!(changes.nodes.is_empty());
    // Frame 6: the row copied back to 10; the card's subtree goes with it.
    layout.begin_frame();
    layout.touch_group(1, None, at(10.).origin, false);
    assert_eq!(x("card"), Some(12.));
    assert_eq!(x("text"), Some(13.));
}

/// A drawing reused after a frame it was not drawn in has its nodes again.
#[test]
fn a_drawing_used_again_brings_its_nodes_back() {
    let layout = LayoutMap::default();
    layout.begin_frame();
    layout.touch_group(1, None, at(0.).origin, true);
    layout.record("card", at(2.), Some(1));
    layout.touch_group(2, Some(1), at(2.).origin, true);
    layout.record("text", at(3.), Some(2));
    layout.begin_frame();
    layout.end_frame();
    assert!(layout.node("text").is_none(), "not drawn");
    assert!(layout.frame(2).is_none());
    layout.take_changes();
    layout.begin_frame();
    layout.touch_group(1, None, at(20.).origin, false);
    layout.end_frame();
    assert_eq!(layout.node("text").map(|node| node.x), Some(23.));
    let changes = layout.take_changes().unwrap();
    assert_eq!(changes.nodes.len(), 2);
    assert_eq!(changes.groups, [1, 2]);
}

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

/// A group of the model: where it is in the one around it, and whether a
/// frame must draw it anew.
struct Group {
    around: Option<usize>,
    x: f32,
    shown: bool,
    dirty: bool,
    drawn: bool,
}

struct Node {
    group: Option<usize>,
    x: f32,
    shown: bool,
}

/// Frames as the renderer makes them, in the new map and the old.
struct Model {
    groups: Vec<Group>,
    nodes: Vec<Node>,
    new: LayoutMap,
    old: OldMap,
    /// The nodes the last frame painted, and where each was last recorded.
    before: BTreeSet<String>,
    recorded: BTreeMap<String, f32>,
}

impl Model {
    /// Something in or about `group` changed: it and the groups around it
    /// are drawn anew (the window outside every group always is).
    fn dirty(&mut self, mut group: Option<usize>) {
        while let Some(index) = group {
            self.groups[index].dirty = true;
            group = self.groups[index].around;
        }
    }

    fn draw(&mut self, around: Option<usize>, origin: f32, rng: &mut Rng) {
        for index in 0..self.nodes.len() {
            let node = &self.nodes[index];
            if node.group == around && node.shown {
                let (id, bounds) = (format!("n{index}"), at(origin + node.x));
                let group = around.map(|group| group as u64 + 1);
                let changed = self.new.record(&id, bounds, group);
                // Changed since it was last recorded, or not painted then.
                // (The old map also said so of a node recorded where it was
                // by a subtree drawn anew after a frame it was reused in.)
                let x = origin + node.x;
                let same = self.before.contains(&id) && self.recorded.get(&id) == Some(&x);
                assert_eq!(changed, !same, "{id}");
                assert!(self.old.record(&id, bounds, group) || !changed, "{id}");
                self.recorded.insert(id, x);
            }
        }
        for index in 0..self.groups.len() {
            let group = &mut self.groups[index];
            if group.around != around || !group.shown {
                continue;
            }
            let drew = group.dirty || !group.drawn || rng.below(4) == 0;
            (group.dirty, group.drawn) = (group.dirty && !drew, true);
            let at = at(origin + group.x).origin;
            let (id, parent) = (index as u64 + 1, around.map(|group| group as u64 + 1));
            self.new.touch_group(id, parent, at, drew);
            self.old.touch_group(id, parent, at, drew);
            if drew {
                self.draw(Some(index), origin + self.groups[index].x, rng);
            }
        }
    }

    fn places(&self) -> (BTreeMap<String, Placed>, BTreeMap<u64, Frame>) {
        let ids = (0..self.nodes.len()).map(|index| format!("n{index}"));
        let nodes = ids.filter_map(|id| Some((id.clone(), self.new.placed(&id)?)));
        let groups = 1..=self.groups.len() as u64;
        let groups = groups.filter_map(|group| Some((group, self.new.frame(group)?)));
        (nodes.collect(), groups.collect())
    }
}

/// Every frame of a long run paints what the old map said it did, and the
/// changes name exactly the nodes and groups whose place is another.
#[test]
fn any_run_of_frames_paints_what_the_old_map_did() {
    let group = |around, x| Group {
        around,
        x,
        shown: true,
        dirty: false,
        drawn: false,
    };
    // Rows in the window, cards in rows, a subtree in a card.
    let groups = vec![
        group(None, 10.),
        group(Some(0), 2.),
        group(Some(1), 1.),
        group(None, 200.),
        group(Some(3), 4.),
        group(Some(0), 50.),
    ];
    let contexts = [None, Some(0), Some(1), Some(2), Some(3), Some(4), Some(5)];
    let nodes = (0..21).map(|index| Node {
        group: contexts[index % contexts.len()],
        x: index as f32,
        shown: true,
    });
    let mut model = Model {
        groups,
        nodes: nodes.collect(),
        new: LayoutMap::default(),
        old: OldMap::default(),
        before: BTreeSet::new(),
        recorded: BTreeMap::new(),
    };
    let mut rng = Rng(11);
    let mut quiet = 0;
    for frame in 0..3000 {
        for _ in 0..rng.below(3) {
            let (group, node) = (rng.below(model.groups.len()), rng.below(model.nodes.len()));
            match rng.below(6) {
                0 => {
                    model.nodes[node].shown ^= true;
                    model.dirty(model.nodes[node].group);
                }
                1 => {
                    model.nodes[node].x = rng.below(40) as f32 / 2.0;
                    model.dirty(model.nodes[node].group);
                }
                // It moves in the group around it, which is drawn anew.
                2 | 3 => {
                    model.groups[group].x = rng.below(300) as f32;
                    model.dirty(model.groups[group].around);
                }
                4 => {
                    model.groups[group].shown ^= true;
                    model.dirty(model.groups[group].around);
                }
                // Its content changed.
                _ => model.dirty(Some(group)),
            }
        }
        let before = model.places();
        let painted = model.old.snapshot().into_iter();
        model.before = painted.map(|node| node.id).collect();
        model.new.take_changes();
        model.new.begin_frame();
        model.old.begin_frame();
        model.draw(None, 0., &mut rng);
        model.new.end_frame();
        assert_eq!(model.new.snapshot(), model.old.snapshot(), "frame {frame}");
        let after = model.places();
        let changes = model.new.take_changes().expect("they were asked for");
        let named: BTreeSet<&str> = changes.nodes.iter().map(|id| &**id).collect();
        let moved = |id: &&String| before.0.get(*id) != after.0.get(*id);
        let ids: BTreeSet<&String> = before.0.keys().chain(after.0.keys()).collect();
        let moved: BTreeSet<&str> = ids.into_iter().filter(moved).map(|id| &**id).collect();
        assert_eq!(named, moved, "the nodes placed elsewhere, frame {frame}");
        let named: BTreeSet<u64> = changes.groups.iter().copied().collect();
        let moved = |group: &&u64| before.1.get(*group) != after.1.get(*group);
        let groups: BTreeSet<&u64> = before.1.keys().chain(after.1.keys()).collect();
        let moved: BTreeSet<u64> = groups.into_iter().filter(moved).copied().collect();
        assert_eq!(named, moved, "the groups placed elsewhere, frame {frame}");
        quiet += usize::from(changes.is_empty());
    }
    assert!(quiet > 300, "frames in which nothing moved say so");
}

#[test]
fn a_node_moved_with_its_group_is_where_laying_it_out_there_puts_it() {
    // GPUI places a node on the grid with one division: at device
    // position `at` in a group whose top left went from `from` to `to`
    // (device pixels), laying it out there gives (at + to - from) / scale.
    for scale in [1.25_f32, 1.5, 1.75, 3.0, 1.1, 2.0, 1.0] {
        for at in [0.0_f32, 7.0, 333.0, 1001.5, 4095.0] {
            for (from, to) in [
                (40.0, 100.0),
                (100.0, 40.0),
                (-3000.0, -2960.0),
                (0.0, 13.0),
            ] {
                let laid = (at + to - from) / scale;
                let moved = super::state::moved_along(scale, at / scale, from / scale, to / scale);
                assert_eq!(moved, laid, "{scale} {at} {from} {to}");
            }
        }
    }
}
