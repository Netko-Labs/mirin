use super::{parse_patch, Document, PatchOp};
use crate::tree::{parse_tree, NodeSpec};

/// A root with a list of three rows (each a view with a text) and a field.
const TREE: &str = r##"{"type":"view","props":{"id":"1"},"children":[
  {"type":"view","props":{"id":"2"},"children":[
    {"type":"view","props":{"id":"a"},"children":[{"type":"text","props":{"id":"ta"},"children":["A"]}]},
    {"type":"view","props":{"id":"b"},"children":[{"type":"text","props":{"id":"tb"},"children":["B"]}]},
    {"type":"view","props":{"id":"c"},"children":[{"type":"text","props":{"id":"tc"},"children":["C"]}]}
  ]},
  {"type":"input","props":{"id":"f","value":"x"}}
]}"##;

fn document() -> Document {
    Document::new(parse_tree(TREE).expect("test tree parses"))
}

fn patch(document: &mut Document, json: &str) -> Result<(), String> {
    let ops = parse_patch(json).map_err(|e| e.to_string())?;
    document.apply(ops).map(|_| ()).map_err(|e| e.to_string())
}

/// The ids of a node's children, in order.
fn children(node: &NodeSpec, id: &str) -> Vec<String> {
    fn find<'a>(node: &'a NodeSpec, id: &str) -> Option<&'a NodeSpec> {
        if node.key() == Some(id) {
            return Some(node);
        }
        match node {
            NodeSpec::View { children, .. } => children.iter().find_map(|c| find(c, id)),
            _ => None,
        }
    }
    match find(node, id) {
        Some(NodeSpec::View { children, .. }) => children
            .iter()
            .map(|child| child.key().unwrap_or("?").to_owned())
            .collect(),
        _ => panic!("no view {id}"),
    }
}

fn text_of(node: &NodeSpec, id: &str) -> String {
    match node {
        NodeSpec::Text { props, children } if props.id.as_deref() == Some(id) => children.concat(),
        NodeSpec::View { children, .. } => children.iter().map(|c| text_of(c, id)).collect(),
        _ => String::new(),
    }
}

/// The same tree, built whole: what a patch must arrive at.
fn whole(json: &str) -> NodeSpec {
    parse_tree(json).expect("expected tree parses")
}

#[test]
fn parses_every_op_strictly() {
    let ops = parse_patch(
        r#"{"patch":[
          {"op":"insert","parent":"2","before":"b","node":{"type":"view","props":{"id":"n"}}},
          {"op":"insert","parent":"2","node":{"type":"text","props":{"id":"t"},"children":["hi"]}},
          {"op":"move","id":"c","parent":"2","before":"a"},
          {"op":"move","id":"a","parent":"2"},
          {"op":"remove","id":"b"},
          {"op":"set","id":"tc","node":{"type":"text","props":{"id":"tc"},"children":["C!"]}}
        ]}"#,
    )
    .expect("a valid patch parses");
    assert_eq!(ops.len(), 6);
    assert!(matches!(&ops[3], PatchOp::Move { before: None, .. }));
    // Unknown ops, unknown fields, and unknown props are refused.
    assert!(parse_patch(r#"{"patch":[{"op":"replace","id":"a"}]}"#).is_err());
    assert!(parse_patch(r#"{"patch":[{"op":"remove","id":"a","why":1}]}"#).is_err());
    assert!(parse_patch(r#"{"patch":[],"seq":1}"#).is_err());
    assert!(parse_patch(
        r#"{"patch":[{"op":"set","id":"a","node":{"type":"view","props":{"id":"a","bogus":1}}}]}"#
    )
    .is_err());
}

#[test]
fn sets_text_and_props_in_place() {
    let mut doc = document();
    patch(
        &mut doc,
        r##"{"patch":[
          {"op":"set","id":"tb","node":{"type":"text","props":{"id":"tb","color":"#ff0000"},"children":["B2"]}},
          {"op":"set","id":"b","node":{"type":"view","props":{"id":"b","background":"#00ff00"}}}
        ]}"##,
    )
    .expect("the patch applies");
    assert_eq!(text_of(&doc, "tb"), "B2");
    // A view's props change; its children stay.
    assert_eq!(children(&doc, "b"), ["tb"]);
    let expected = TREE
        .replace(
            r#"{"type":"text","props":{"id":"tb"},"children":["B"]}"#,
            r##"{"type":"text","props":{"id":"tb","color":"#ff0000"},"children":["B2"]}"##,
        )
        .replace(
            r#""props":{"id":"b"}"#,
            r##""props":{"id":"b","background":"#00ff00"}"##,
        );
    assert_eq!(*doc, whole(&expected));
}

#[test]
fn inserts_moves_and_removes_keyed_children() {
    let mut doc = document();
    // A keyed reorder: c, a, b; then a new row d before a, and b goes.
    patch(
        &mut doc,
        r#"{"patch":[
          {"op":"move","id":"c","parent":"2","before":"a"},
          {"op":"insert","parent":"2","before":"a","node":{"type":"view","props":{"id":"d"},"children":[{"type":"text","props":{"id":"td"},"children":["D"]}]}},
          {"op":"remove","id":"b"}
        ]}"#,
    )
    .expect("the patch applies");
    assert_eq!(children(&doc, "2"), ["c", "d", "a"]);
    // The removed subtree's ids are gone; the inserted ones are addressable.
    assert!(patch(&mut doc, r#"{"patch":[{"op":"remove","id":"tb"}]}"#).is_err());
    let mut doc = document();
    patch(
        &mut doc,
        r#"{"patch":[{"op":"move","id":"a","parent":"2"},{"op":"move","id":"b","parent":"2"}]}"#,
    )
    .expect("moves to the end apply");
    assert_eq!(children(&doc, "2"), ["c", "a", "b"]);
    patch(
        &mut doc,
        r#"{"patch":[{"op":"set","id":"td","node":{"type":"text","props":{"id":"td"},"children":["x"]}}]}"#,
    )
    .expect_err("td was never inserted in this document");
}

#[test]
fn a_node_can_move_to_another_parent_but_not_into_itself() {
    let mut doc = document();
    patch(
        &mut doc,
        r#"{"patch":[{"op":"move","id":"c","parent":"a","before":"ta"}]}"#,
    )
    .expect("moving under a sibling applies");
    assert_eq!(children(&doc, "a"), ["c", "ta"]);
    assert_eq!(children(&doc, "2"), ["a", "b"]);
    let mut doc = document();
    assert!(patch(
        &mut doc,
        r#"{"patch":[{"op":"move","id":"2","parent":"a"}]}"#
    )
    .is_err());
    let mut doc = document();
    assert!(patch(
        &mut doc,
        r#"{"patch":[{"op":"move","id":"1","parent":"2"}]}"#
    )
    .is_err());
}

#[test]
fn refuses_what_it_cannot_apply() {
    let refused = [
        // Unknown ids, as the node, the parent, or the sibling.
        r#"{"patch":[{"op":"remove","id":"zz"}]}"#,
        r#"{"patch":[{"op":"insert","parent":"zz","node":{"type":"view","props":{"id":"n"}}}]}"#,
        r#"{"patch":[{"op":"insert","parent":"2","before":"ta","node":{"type":"view","props":{"id":"n"}}}]}"#,
        // An id already in the tree, anywhere in the new subtree.
        r#"{"patch":[{"op":"insert","parent":"2","node":{"type":"view","props":{"id":"n"},"children":[{"type":"text","props":{"id":"ta"},"children":[]}]}}]}"#,
        // Children only go under views.
        r#"{"patch":[{"op":"insert","parent":"f","node":{"type":"view","props":{"id":"n"}}}]}"#,
        // The root stays.
        r#"{"patch":[{"op":"remove","id":"1"}]}"#,
        // A set keeps the node's id and type, and never sets a view's children.
        r#"{"patch":[{"op":"set","id":"a","node":{"type":"view","props":{"id":"b"}}}]}"#,
        r#"{"patch":[{"op":"set","id":"ta","node":{"type":"view","props":{"id":"ta"}}}]}"#,
        r#"{"patch":[{"op":"set","id":"a","node":{"type":"view","props":{"id":"a"},"children":[{"type":"view","props":{"id":"q"}}]}}]}"#,
    ];
    for json in refused {
        let mut doc = document();
        assert!(patch(&mut doc, json).is_err(), "should refuse {json}");
    }
}

#[test]
fn a_root_without_an_id_or_with_twice_the_same_cannot_be_patched() {
    let mut doc = Document::new(whole(r#"{"type":"view","props":{}}"#));
    assert!(patch(&mut doc, r#"{"patch":[{"op":"remove","id":"x"}]}"#).is_err());
    let mut doc = Document::new(whole(
        r#"{"type":"view","props":{"id":"1"},"children":[{"type":"view","props":{"id":"x"}},{"type":"view","props":{"id":"x"}}]}"#,
    ));
    assert!(patch(&mut doc, r#"{"patch":[{"op":"remove","id":"x"}]}"#).is_err());
}

#[test]
fn generations_say_what_changed() {
    let mut doc = document();
    let start = doc.generation();
    assert_eq!(doc.subtree_generation("a"), start);
    patch(
        &mut doc,
        r#"{"patch":[{"op":"set","id":"tb","node":{"type":"text","props":{"id":"tb"},"children":["B2"]}}]}"#,
    )
    .expect("the patch applies");
    let now = doc.generation();
    assert_eq!(now, start + 1);
    // The text, and every view above it, changed below; nothing else did.
    for id in ["tb", "b", "2", "1"] {
        assert_eq!(doc.subtree_generation(id), now, "{id}");
    }
    assert_eq!(doc.own_generation("tb"), now);
    assert_eq!(doc.own_generation("b"), start);
    for id in ["a", "ta", "c", "tc", "f"] {
        assert_eq!(doc.subtree_generation(id), start, "{id}");
    }
    // A reorder changes the parent's own children; the moved rows are as they were.
    patch(
        &mut doc,
        r#"{"patch":[{"op":"move","id":"c","parent":"2","before":"a"}]}"#,
    )
    .expect("the move applies");
    let moved = doc.generation();
    assert_eq!(doc.own_generation("2"), moved);
    assert_eq!(doc.subtree_generation("1"), moved);
    assert_eq!(doc.subtree_generation("c"), start);
    assert_eq!(doc.subtree_generation("b"), now);
    // Inserted nodes are new in their update.
    patch(
        &mut doc,
        r#"{"patch":[{"op":"insert","parent":"a","node":{"type":"view","props":{"id":"n"},"children":[{"type":"text","props":{"id":"tn"},"children":[]}]}}]}"#,
    )
    .expect("the insert applies");
    let inserted = doc.generation();
    assert_eq!(doc.subtree_generation("tn"), inserted);
    assert_eq!(doc.own_generation("a"), inserted);
    // A whole tree changes everything.
    doc.replace(parse_tree(TREE).expect("test tree parses"));
    let replaced = doc.generation();
    for id in ["1", "c", "tc", "unknown"] {
        assert_eq!(doc.subtree_generation(id), replaced, "{id}");
    }
}

#[test]
fn a_failed_patch_marks_everything_changed() {
    let mut doc = document();
    let failed = patch(
        &mut doc,
        r#"{"patch":[{"op":"remove","id":"a"},{"op":"remove","id":"zz"}]}"#,
    );
    assert!(failed.is_err());
    // As far as it got, and every node counts as changed.
    assert_eq!(children(&doc, "2"), ["b", "c"]);
    assert_eq!(doc.subtree_generation("c"), doc.generation());
    // A whole tree brings it back in step.
    doc.replace(parse_tree(TREE).expect("test tree parses"));
    patch(&mut doc, r#"{"patch":[{"op":"remove","id":"a"}]}"#).expect("patches apply again");
}

#[test]
fn a_patch_never_copies_an_unshared_tree() {
    let mut doc = document();
    let before = std::rc::Rc::as_ptr(doc.tree());
    patch(&mut doc, r#"{"patch":[{"op":"remove","id":"b"}]}"#).expect("the patch applies");
    assert_eq!(std::rc::Rc::as_ptr(doc.tree()), before);
    // A frame still holding the tree keeps what it walks; the patch copies.
    let frame = std::rc::Rc::clone(doc.tree());
    patch(&mut doc, r#"{"patch":[{"op":"remove","id":"c"}]}"#).expect("the patch applies");
    assert_eq!(children(&frame, "2"), ["a", "c"]);
    assert_eq!(children(&doc, "2"), ["a"]);
}

#[test]
fn portals_are_children_like_any_other() {
    // A portal renders into a mounted view elsewhere (an overlay layer): to
    // the host that is an insert under that view, wherever it is.
    let mut doc = document();
    patch(
        &mut doc,
        r#"{"patch":[
          {"op":"insert","parent":"1","node":{"type":"view","props":{"id":"layer"}}},
          {"op":"insert","parent":"layer","node":{"type":"view","props":{"id":"menu"},"children":[{"type":"text","props":{"id":"tm"},"children":["Menu"]}]}}
        ]}"#,
    )
    .expect("the portal's inserts apply");
    assert_eq!(children(&doc, "1"), ["2", "f", "layer"]);
    assert_eq!(text_of(&doc, "tm"), "Menu");
    patch(&mut doc, r#"{"patch":[{"op":"remove","id":"menu"}]}"#).expect("the portal unmounts");
    assert!(children(&doc, "layer").is_empty());
}
