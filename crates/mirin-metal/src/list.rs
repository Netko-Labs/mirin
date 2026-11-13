//! Virtualized scrolling for long vertical lists. A scrollable column with many
//! children renders as a GPUI `list`: only rows near the viewport are laid out
//! and painted each frame, and measured row heights are cached between frames.
//! Without this, every frame lays out every row, so a list's cost grows with
//! its length rather than with the window.
//!
//! Row heights stay cached across tree updates; `sync` compares each list's
//! old and new children and invalidates only the rows that changed.
//!
//! The rows are drawn in a group of the layout map (`layout.rs`), the
//! list's content, whose top left is where the list paints it: a scroll
//! moves that group alone, as it does a scroll view's content.

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
    spacing: Spacing,
}

/// Padding around the rows (summed over the container and any wrappers) and
/// the gap between them.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Spacing {
    gap: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
}

impl Spacing {
    /// Add a view's padding; per side wins over axis, axis over all, as in
    /// `render.rs`.
    fn add_padding(&mut self, props: &ViewProps) {
        self.left += props
            .padding_left
            .or(props.padding_x)
            .unwrap_or(props.padding);
        self.right += props
            .padding_right
            .or(props.padding_x)
            .unwrap_or(props.padding);
        self.top += props
            .padding_top
            .or(props.padding_y)
            .unwrap_or(props.padding);
        self.bottom += props
            .padding_bottom
            .or(props.padding_y)
            .unwrap_or(props.padding);
    }
}

/// How deep to look through layout-only wrappers for the rows
/// (`ScrollArea` viewport → app wrapper → rows).
const MAX_WRAPPERS: usize = 4;

/// The rows a view would virtualize, if it qualifies. Only vertical scroll
/// views whose rows are a plain stack (full-width rows, top to bottom, no
/// wrapping or cross-axis alignment) qualify, so the list lays rows out as
/// the view would. Rows may sit inside layout-only wrappers, like
/// `<ScrollArea><div className="p-4">{rows}</div></ScrollArea>`.
fn find_rows<'a>(props: &ViewProps, children: &'a [NodeSpec]) -> Option<(&'a [NodeSpec], Spacing)> {
    if !props.scroll
        || props.scroll_x
        || props.id.is_none()
        || props.on_press
        || props.on_hover
        || props.on_pointer
        || props.on_context_menu
        || props.on_key_down
        || props.on_wheel
        || props.drag_files.is_some()
        || props.hover_background.is_some()
    {
        return None;
    }
    let mut spacing = Spacing::default();
    spacing.add_padding(props);
    let mut level = props;
    let mut rows = children;
    for _ in 0..=MAX_WRAPPERS {
        if !stacks_rows(level) {
            return None;
        }
        spacing.gap = level.gap;
        if rows.len() >= MIN_ROWS {
            return Some((rows, spacing));
        }
        let [NodeSpec::View {
            props: wrapper,
            children,
        }] = rows
        else {
            return None;
        };
        if !layout_only(wrapper) {
            return None;
        }
        spacing.add_padding(wrapper);
        level = wrapper;
        rows = children;
    }
    None
}

/// Whether a view lays its children out as a plain top-to-bottom stack.
fn stacks_rows(props: &ViewProps) -> bool {
    props.direction == Direction::Column
        && !props.wrap
        && !props.center
        && props.justify.is_none()
        && matches!(props.align, None | Some(Align::Stretch))
}

/// A wrapper that only arranges its children: no appearance, size, or
/// interaction of its own, so dropping its element changes nothing visible.
fn layout_only(props: &ViewProps) -> bool {
    if props.on_layout || !stacks_rows(props) {
        return false;
    }
    let bare = ViewProps {
        id: None,
        gap: 0.0,
        padding: 0.0,
        padding_x: None,
        padding_y: None,
        padding_top: None,
        padding_bottom: None,
        padding_left: None,
        padding_right: None,
        flex: 0.0,
        grow: 0.0,
        shrink: None,
        ..props.clone()
    };
    bare == ViewProps::default()
}

/// Whether a view renders as a virtualized list.
pub(crate) fn virtualizes(props: &ViewProps, children: &[NodeSpec]) -> bool {
    find_rows(props, children).is_some()
}

/// Bring list state in line with a new tree: create state for new lists,
/// invalidate changed rows, and drop lists that left the tree.
pub(crate) fn sync(lists: &mut HashMap<String, VirtualList>, tree: &NodeSpec) {
    let mut found = Vec::new();
    collect(tree, &mut found);
    let mut next = HashMap::with_capacity(found.len());
    for (id, rows, spacing) in found {
        let entry = match lists.remove(id) {
            Some(mut entry) => {
                if entry.spacing == spacing {
                    invalidate_changed(&entry.state, &entry.rows, rows);
                } else {
                    entry.state.reset(rows.len());
                }
                entry.rows = Rc::new(rows.to_vec());
                entry.spacing = spacing;
                entry
            }
            None => {
                crate::trace::log(format_args!("virtual list {id}: {} rows", rows.len()));
                VirtualList {
                    state: ListState::new(rows.len(), ListAlignment::Top, px(OVERDRAW)),
                    rows: Rc::new(rows.to_vec()),
                    spacing,
                }
            }
        };
        next.insert(id.to_string(), entry);
    }
    *lists = next;
}

fn collect<'a>(node: &'a NodeSpec, out: &mut Vec<(&'a str, &'a [NodeSpec], Spacing)>) {
    if let NodeSpec::View { props, children } = node {
        if let (Some(id), Some((rows, spacing))) = (props.id.as_deref(), find_rows(props, children))
        {
            out.push((id, rows, spacing));
            // Rows render through the list; nested lists inside rows are found
            // when walking the rows themselves.
            for row in rows {
                collect(row, out);
            }
            return;
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

/// Render a virtualized list inside its already-styled container. Padding
/// (the container's and its wrappers') moves inside the list so it scrolls
/// with the rows, as padding inside a CSS scroll container does.
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
    let spacing = entry.spacing;
    let layout = view.layout.clone();
    let events = view.events.clone();
    // The rows are a group of the layout map, as a scroll view's content
    // is (`layout/scroll.rs`): its top left is where the list's content is
    // painted (`List::on_content_origin`), so a scroll moves the group and
    // no row.
    let group = crate::layout::scroll_group(id);
    let around = view.group;
    let rows_group = Some(group);
    let render_row = cx.processor(move |view: &mut RootView, index: usize, window, cx| {
        let Some(node) = rows.get(index) else {
            return div().into_any_element();
        };
        let outer = std::mem::replace(&mut view.group, rows_group);
        let element = render_node(node, view, window, cx);
        view.group = outer;
        // GPUI's list applies only vertical padding; horizontal padding goes
        // on each row.
        let mut row = div()
            .w_full()
            .flex()
            .flex_col()
            .pl(px(spacing.left))
            .pr(px(spacing.right))
            .child(element);
        if index > 0 && spacing.gap > 0.0 {
            row = row.pt(px(spacing.gap));
        }
        if let Some(id) = node_id(node) {
            let watch = watches_layout(node);
            let (layout, events) = (layout.clone(), events.clone());
            row = row.on_children_prepainted(move |bounds, _window, _cx| {
                if let Some(bounds) = bounds.first() {
                    record_child_bounds(&layout, &events, &id, watch, *bounds, rows_group);
                }
            });
        }
        row.into_any_element()
    });
    container.style().padding = Default::default();
    let state = entry.state.clone();
    let layout = view.layout.clone();
    let rows_element = list(state.clone(), render_row)
        .on_content_origin(move |origin, _window, _cx| {
            layout.touch_group(group, around, origin, true);
        })
        .size_full()
        .pt(px(spacing.top))
        .pb(px(spacing.bottom));
    let activity = view
        .scroll_activity
        .entry(id.to_string())
        .or_default()
        .clone();
    // After the list, so the list has laid out its viewport when the bar reads it.
    let bar = crate::scrollbar::bars_for(crate::scrollbar::Scrolled::List(state), activity);
    container.child(rows_element).child(bar).into_any_element()
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

    fn view(props: ViewProps, children: Vec<NodeSpec>) -> NodeSpec {
        NodeSpec::View {
            props: Box::new(props),
            children,
        }
    }

    fn scroll_view() -> ViewProps {
        ViewProps {
            id: Some("list".into()),
            scroll: true,
            padding: 4.0,
            ..ViewProps::default()
        }
    }

    #[test]
    fn finds_rows_through_layout_only_wrappers() {
        let many: Vec<NodeSpec> = (0..80).map(|i| text(&i.to_string())).collect();
        let wrapper = ViewProps {
            padding: 16.0,
            gap: 2.0,
            ..ViewProps::default()
        };
        let children = vec![view(wrapper, many.clone())];
        let props = scroll_view();
        let (rows, spacing) = find_rows(&props, &children).expect("virtualizes");
        assert_eq!(rows.len(), 80);
        assert_eq!((spacing.left, spacing.top, spacing.gap), (20.0, 20.0, 2.0));
    }

    #[test]
    fn a_styled_wrapper_or_a_short_list_does_not_virtualize() {
        let many: Vec<NodeSpec> = (0..80).map(|i| text(&i.to_string())).collect();
        let styled = ViewProps {
            background: Some("#ffffff".into()),
            ..ViewProps::default()
        };
        let children = vec![view(styled, many)];
        assert!(find_rows(&scroll_view(), &children).is_none());
        let few: Vec<NodeSpec> = (0..10).map(|i| text(&i.to_string())).collect();
        assert!(find_rows(&scroll_view(), &few).is_none());
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
