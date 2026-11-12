// mirin: the places looked up (`sibling_index.rs`) and the children's
// changes found through sets (`ChildSet` in `node.rs`) against upstream's
// way of working them out, on random trees changed at random.

use accesskit::{
    ActionHandler, ActionRequest, Node, NodeId, Rect, Role, TreeId, TreeInfo, TreeUpdate,
};
use accesskit_consumer::{FilterResult, FullNodeId, NodeRef, Tree, TreeChangeHandler};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use super::COUNTED;
use crate::filters::filter;
use crate::{
    Adapter, AdapterCallback, AppContext, Event, InterfaceSet, NodeIdOrRoot, ObjectEvent,
    WindowBounds,
};

struct NoAction;
impl ActionHandler for NoAction {
    fn do_action(&mut self, _: ActionRequest) {}
}

/// A child gained (with its place) or lost.
#[derive(Debug, PartialEq)]
enum Change {
    Added(usize, FullNodeId),
    Removed(FullNodeId),
}

/// The children changes the adapter announced, by parent.
type Announced = Arc<Mutex<Vec<(FullNodeId, Change)>>>;

struct Children(Announced);
impl AdapterCallback for Children {
    fn register_interfaces(&self, _: &Adapter, _: FullNodeId, _: InterfaceSet) {}
    fn unregister_interfaces(&self, _: &Adapter, _: FullNodeId, _: InterfaceSet) {}
    fn emit_event(&self, _: &Adapter, event: Event) {
        if let Event::Object {
            target: NodeIdOrRoot::Node(target),
            event,
        } = event
        {
            let change = match event {
                ObjectEvent::ChildAdded(index, child) => Change::Added(index, child),
                ObjectEvent::ChildRemoved(child) => Change::Removed(child),
                _ => return,
            };
            self.0.lock().unwrap().push((target, change));
        }
    }
}

/// The nodes upstream's tree reports updated: the ones the adapter looks
/// at for children gained and lost.
#[derive(Default)]
struct Updated(Vec<NodeId>);
impl TreeChangeHandler for Updated {
    fn node_added(&mut self, _: &NodeRef) {}
    fn node_updated(&mut self, _: &NodeRef, new: &NodeRef) {
        self.0.push(new.locate().0);
    }
    fn focus_moved(&mut self, _: Option<&NodeRef>, _: Option<&NodeRef>) {}
    fn node_removed(&mut self, _: &NodeRef) {}
}

/// xorshift: the same random trees on every run.
struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A random tree as one whole update: containers the filter sees through,
/// hidden subtrees, a clipping parent with children out of its bounds, and
/// long rows of siblings (longer than `COUNTED`).
fn random_tree(random: &mut Random) -> TreeUpdate {
    let mut nodes = BTreeMap::new();
    let mut next = 1;
    fn grow(
        random: &mut Random,
        nodes: &mut BTreeMap<u64, Node>,
        next: &mut u64,
        depth: u32,
        y: f64,
    ) -> u64 {
        let id = *next;
        *next += 1;
        let role = match random.below(5) {
            0 | 1 => Role::GenericContainer,
            2 => Role::Button,
            3 => Role::Label,
            _ => Role::List,
        };
        let mut node = Node::new(role);
        node.set_bounds(Rect::new(0.0, y, 40.0, y + 10.0));
        if random.below(12) == 0 {
            node.set_hidden();
        }
        if depth < 3 && role != Role::Label {
            let count = match random.below(4) {
                0 => 0,
                1 => random.below(4),
                _ => COUNTED as u64 + random.below(30),
            };
            if random.below(6) == 0 {
                node.set_clips_children();
            }
            let children: Vec<NodeId> = (0..count)
                .map(|index| {
                    let child = grow(random, nodes, next, depth + 1, y + index as f64 * 12.0);
                    NodeId(child)
                })
                .collect();
            node.set_children(children);
        }
        nodes.insert(id, node);
        id
    }
    let child = grow(random, &mut nodes, &mut next, 1, 0.0);
    let mut root = Node::new(Role::Window);
    root.set_bounds(Rect::new(0.0, 0.0, 400.0, 300.0));
    root.set_children(vec![NodeId(child)]);
    nodes.insert(0, root);
    let focus = NodeId(random.below(next));
    TreeUpdate {
        nodes: nodes
            .into_iter()
            .map(|(id, node)| (NodeId(id), node))
            .collect(),
        tree: Some(TreeInfo::new(NodeId(0))),
        tree_id: TreeId::ROOT,
        focus,
    }
}

/// A random change to `tree`: a parent's children reversed, rotated or cut,
/// a node hidden or shown, or the focus moved.
fn random_change(random: &mut Random, tree: &Tree) -> TreeUpdate {
    let mut ids = Vec::new();
    fn gather(node: &NodeRef, ids: &mut Vec<(NodeId, Node)>) {
        ids.push((node.locate().0, node.data().clone()));
        for child in node.children() {
            gather(&child, ids);
        }
    }
    gather(&tree.state().root(), &mut ids);
    let mut nodes: Vec<(NodeId, Node)> = Vec::new();
    for _ in 0..1 + random.below(3) {
        let (id, mut node) = ids[random.below(ids.len() as u64) as usize].clone();
        let mut children = node.children().to_vec();
        match random.below(5) {
            0 => children.reverse(),
            1 if !children.is_empty() => {
                let by = random.below(children.len() as u64) as usize;
                children.rotate_left(by);
            }
            2 => children.truncate(children.len() / 2),
            3 if node.is_hidden() => node.clear_hidden(),
            3 if id != NodeId(0) => node.set_hidden(),
            _ => {}
        }
        node.set_children(children);
        nodes.retain(|(other, _)| *other != id);
        nodes.push((id, node));
    }
    // What is still in the tree once the children were cut: the focus is
    // one of them, and a node cut away is not named.
    let children: BTreeMap<NodeId, Vec<NodeId>> = ids
        .iter()
        .chain(nodes.iter())
        .map(|(id, node)| (*id, node.children().to_vec()))
        .collect();
    let mut kept = vec![NodeId(0)];
    let mut at = 0;
    while at < kept.len() {
        kept.extend(children[&kept[at]].iter().copied());
        at += 1;
    }
    nodes.retain(|(id, _)| kept.contains(id));
    let focus = kept[random.below(kept.len() as u64) as usize];
    TreeUpdate {
        nodes,
        tree: None,
        tree_id: TreeId::ROOT,
        focus,
    }
}

/// Every node the filter includes, with its filtered parent, upstream's
/// count of the filtered siblings before it, and the filtered children.
fn expected(tree: &Tree) -> Vec<(NodeId, Option<usize>, Vec<NodeId>)> {
    fn gather(node: &NodeRef, out: &mut Vec<(NodeId, Option<usize>, Vec<NodeId>)>) {
        if filter(node) == FilterResult::Include {
            let index = node
                .filtered_parent(&filter)
                .map(|_| node.preceding_filtered_siblings(&filter).count());
            let children = node
                .filtered_children(&filter)
                .map(|child| child.locate().0)
                .collect();
            out.push((node.locate().0, index, children));
        }
        for child in node.children() {
            gather(&child, out);
        }
    }
    let mut out = Vec::new();
    gather(&tree.state().root(), &mut out);
    out
}

fn full_id(tree: &Tree, id: NodeId) -> FullNodeId {
    tree.state()
        .node_by_tree_local_id(id, TreeId::ROOT)
        .expect("a node of the tree")
        .id()
}

/// Every node's full id, by its id.
fn full_ids(tree: &Tree) -> BTreeMap<NodeId, FullNodeId> {
    fn gather(node: &NodeRef, ids: &mut BTreeMap<NodeId, FullNodeId>) {
        ids.insert(node.locate().0, node.id());
        for child in node.children() {
            gather(&child, ids);
        }
    }
    let mut ids = BTreeMap::new();
    gather(&tree.state().root(), &mut ids);
    ids
}

#[test]
fn places_are_the_count_of_siblings_before() {
    let mut random = Random(0x9e37_79b9_7f4a_7c15);
    let mut long_rows = 0;
    for _ in 0..24 {
        let first = random_tree(&mut random);
        let announced = Announced::default();
        let mut adapter = Adapter::new(
            &AppContext::new(None),
            Children(Arc::clone(&announced)),
            first.clone(),
            true,
            WindowBounds::default(),
            NoAction,
        );
        // AccessKit's own tree beside the adapter's: the places counted
        // as upstream counts them.
        let mut mirror = Tree::new(first, true);
        for step in 0..8 {
            let nodes = expected(&mirror);
            // Asked last to first, then first to last: the places stay
            // right whichever sibling is asked first.
            for pass in 0..2 {
                for offset in 0..nodes.len() {
                    let at = if pass == 0 {
                        nodes.len() - 1 - offset
                    } else {
                        offset
                    };
                    let (id, index, children) = &nodes[at];
                    let node = adapter.platform_node(full_id(&mirror, *id));
                    let cached = node.cache_node().expect("a node of the tree");
                    if let Some(index) = index {
                        long_rows += usize::from(*index >= COUNTED);
                        assert_eq!(cached.index_in_parent as usize, *index, "step {step}");
                        assert_eq!(node.index_in_parent().unwrap() as usize, *index);
                    }
                    assert_eq!(cached.child_count as usize, children.len());
                }
            }
            let change = random_change(&mut random, &mirror);
            // The children each changed node gained and lost, as upstream
            // lists them: added in the new order, then removed in the old.
            let before: BTreeMap<_, _> = nodes
                .iter()
                .map(|(id, _, children)| (*id, children.clone()))
                .collect();
            let old_ids = full_ids(&mirror);
            announced.lock().unwrap().clear();
            adapter.update(change.clone());
            let mut updated = Updated::default();
            mirror.update_and_process_changes(change, &mut updated);
            let after: BTreeMap<_, _> = expected(&mirror)
                .into_iter()
                .map(|(id, _, children)| (id, children))
                .collect();
            let heard = std::mem::take(&mut *announced.lock().unwrap());
            for id in &updated.0 {
                let (Some(old), Some(new)) = (before.get(id), after.get(id)) else {
                    continue;
                };
                let parent = full_id(&mirror, *id);
                let mut wanted = Vec::new();
                for (index, child) in new.iter().enumerate() {
                    if !old.contains(child) {
                        wanted.push(Change::Added(index, full_id(&mirror, *child)));
                    }
                }
                for child in old {
                    if !new.contains(child) {
                        wanted.push(Change::Removed(old_ids[child]));
                    }
                }
                let heard: Vec<_> = heard
                    .iter()
                    .filter(|(target, _)| *target == parent)
                    .map(|(_, change)| change)
                    .collect();
                assert_eq!(heard, wanted.iter().collect::<Vec<_>>(), "step {step}");
            }
        }
    }
    // The places were looked up, not only counted.
    assert!(long_rows > 1000, "{long_rows} places past {COUNTED}");
}
