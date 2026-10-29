//! Virtualized scrolling for long vertical lists. A scrollable column with many
//! children renders as a GPUI `list`: only rows near the viewport are laid out
//! and painted each frame, and measured row heights are cached between frames.
//! Without this, every frame lays out every row, so a list's cost grows with
//! its length rather than with the window.
//!
//! Row heights stay cached across tree updates; `sync` compares each list's
//! old and new children and invalidates only the rows that changed.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{div, list, prelude::*, px, AnyElement, Context, Div, ListAlignment, ListState};

use crate::render::{node_id, record_child_bounds, render_node, watches_layout};
use crate::tree::{Align, Direction, NodeSpec, ViewProps};
use crate::window::RootView;

/// Lists shorter than this render as plain scroll views.
const MIN_ROWS: usize = 64;

/// How far beyond the viewport rows are laid out, so fast scrolls stay filled.
const OVERDRAW: f32 = 400.0;

/// Renderer-owned state of one virtualized list.
pub(crate) struct VirtualList {
    pub(crate) state: ListState,
    /// The rows, cloned from the tree when it changes (not per frame).
    rows: Rc<Vec<NodeSpec>>,
}

/// Whether a view renders as a virtualized list. Only plain vertical stacks
/// qualify, so the list's row layout matches what the view would produce:
/// full-width rows, top to bottom, no wrapping or cross-axis alignment.
pub(crate) fn virtualizes(props: &ViewProps, children: &[NodeSpec]) -> bool {
    props.scroll
        && !props.scroll_x
        && props.id.is_some()
        && props.direction == Direction::Column
        && !props.wrap
        && !props.center
        && props.justify.is_none()
        && matches!(props.align, None | Some(Align::Stretch))
        && !props.on_press
        && !props.on_hover
        && !props.on_pointer
        && !props.on_context_menu
        && props.hover_background.is_none()
        && children.len() >= MIN_ROWS
}

/// Bring list state in line with a new tree: create state for new lists,
/// invalidate changed rows, and drop lists that left the tree.
pub(crate) fn sync(lists: &mut HashMap<String, VirtualList>, tree: &NodeSpec) {
    let mut found = Vec::new();
    collect(tree, &mut found);
    let mut next = HashMap::with_capacity(found.len());
    for (id, rows) in found {
        let entry = match lists.remove(id) {
            Some(mut entry) => {
                invalidate_changed(&entry.state, &entry.rows, rows);
                entry.rows = Rc::new(rows.to_vec());
                entry
            }
            None => VirtualList {
                state: ListState::new(rows.len(), ListAlignment::Top, px(OVERDRAW)),
                rows: Rc::new(rows.to_vec()),
            },
        };
        next.insert(id.to_string(), entry);
    }
    *lists = next;
}

fn collect<'a>(node: &'a NodeSpec, out: &mut Vec<(&'a str, &'a [NodeSpec])>) {
    if let NodeSpec::View { props, children } = node {
        if virtualizes(props, children) {
            if let Some(id) = props.id.as_deref() {
                out.push((id, children));
            }
        }
        for child in children {
            collect(child, out);
        }
    }
}

/// Splice the range between the unchanged head and tail of the rows, so
/// cached heights survive for every row that did not change.
fn invalidate_changed(state: &ListState, old: &[NodeSpec], new: &[NodeSpec]) {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    if prefix == old.len() && old.len() == new.len() {
        return;
    }
    let room = old.len().min(new.len()) - prefix;
    let mut suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    // The first row has no gap above it; if it changed identity, re-measure
    // the row that becomes first as well.
    if prefix == 0 && suffix > 0 && suffix == new.len().min(old.len()) {
        suffix -= 1;
    }
    state.splice(prefix..old.len() - suffix, new.len() - prefix - suffix);
}

/// Render a virtualized list inside its already-styled container. The
/// container's padding moves inside the list so it scrolls with the rows, as
/// padding inside a CSS scroll container does.
pub(crate) fn render_list(
    mut container: Div,
    props: &ViewProps,
    view: &mut RootView,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let Some(id) = props.id.as_deref() else {
        return container.into_any_element();
    };
    let Some(entry) = view.lists.get(id) else {
        return container.into_any_element();
    };
    let rows = entry.rows.clone();
    let gap = props.gap;
    // GPUI's list applies only vertical padding; horizontal padding goes on
    // each row. Same precedence as the view: per side, then axis, then all.
    let left = props
        .padding_left
        .or(props.padding_x)
        .unwrap_or(props.padding);
    let right = props
        .padding_right
        .or(props.padding_x)
        .unwrap_or(props.padding);
    let top = props
        .padding_top
        .or(props.padding_y)
        .unwrap_or(props.padding);
    let bottom = props
        .padding_bottom
        .or(props.padding_y)
        .unwrap_or(props.padding);
    let layout = view.layout.clone();
    let events = view.events.clone();
    let render_row = cx.processor(move |view: &mut RootView, index: usize, window, cx| {
        let Some(node) = rows.get(index) else {
            return div().into_any_element();
        };
        let element = render_node(node, view, window, cx);
        let mut row = div()
            .w_full()
            .flex()
            .flex_col()
            .pl(px(left))
            .pr(px(right))
            .child(element);
        if index > 0 && gap > 0.0 {
            row = row.pt(px(gap));
        }
        if let Some(id) = node_id(node) {
            let watch = watches_layout(node);
            let (layout, events) = (layout.clone(), events.clone());
            row = row.on_children_prepainted(move |bounds, _window, _cx| {
                if let Some(bounds) = bounds.first() {
                    record_child_bounds(&layout, &events, &id, watch, *bounds);
                }
            });
        }
        row.into_any_element()
    });
    container.style().padding = Default::default();
    let rows_element = list(entry.state.clone(), render_row)
        .size_full()
        .pt(px(top))
        .pb(px(bottom));
    container.child(rows_element).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> NodeSpec {
        NodeSpec::Text {
            props: Default::default(),
            children: vec![value.to_string()],
        }
    }

    fn rows(values: &[&str]) -> Vec<NodeSpec> {
        values.iter().map(|value| text(value)).collect()
    }

    #[test]
    fn unchanged_rows_keep_their_state() {
        let state = ListState::new(3, ListAlignment::Top, px(0.0));
        invalidate_changed(&state, &rows(&["a", "b", "c"]), &rows(&["a", "b", "c"]));
        assert_eq!(state.item_count(), 3);
    }

    #[test]
    fn appended_and_removed_rows_change_the_count() {
        let state = ListState::new(3, ListAlignment::Top, px(0.0));
        invalidate_changed(
            &state,
            &rows(&["a", "b", "c"]),
            &rows(&["a", "b", "c", "d"]),
        );
        assert_eq!(state.item_count(), 4);
        invalidate_changed(
            &state,
            &rows(&["a", "b", "c", "d"]),
            &rows(&["b", "c", "d"]),
        );
        assert_eq!(state.item_count(), 3);
        invalidate_changed(&state, &rows(&["b", "c", "d"]), &rows(&["b", "x", "d"]));
        assert_eq!(state.item_count(), 3);
    }
}
