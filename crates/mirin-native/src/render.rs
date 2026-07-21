//! Tree → GPUI elements: turn a parsed `NodeSpec` into GPUI's element tree.
//! Pure per-frame mapping; state lives in the driver, exactly like React
//! Native's shadow tree → native views step.

use gpui::{div, prelude::*, px, rgb, AnyElement, App, ElementId, SharedString, Window};

use crate::events::EventSender;
use crate::tree::{parse_color, Direction, NodeSpec, TextProps, ViewProps};

/// Render one node (and its subtree) into a GPUI element.
pub(crate) fn render_node(node: &NodeSpec, events: &EventSender) -> AnyElement {
    match node {
        NodeSpec::View { props, children } => render_view(props, children, events),
        NodeSpec::Text { props, children } => render_text(props, children),
    }
}

fn render_view(props: &ViewProps, children: &[NodeSpec], events: &EventSender) -> AnyElement {
    let mut element = div();
    element = match props.direction {
        Direction::Column => element.flex().flex_col(),
        Direction::Row => element.flex().flex_row(),
    };
    if props.gap > 0.0 {
        element = element.gap(px(props.gap));
    }
    if props.padding > 0.0 {
        element = element.p(px(props.padding));
    }
    if let Some(width) = props.width {
        element = element.w(px(width));
    }
    if let Some(height) = props.height {
        element = element.h(px(height));
    }
    if props.fill {
        element = element.size_full();
    }
    if props.center {
        element = element.items_center().justify_center();
    }
    if let Some(color) = props.background.as_deref().and_then(parse_color) {
        element = element.bg(rgb(color));
    }
    if props.corner_radius > 0.0 {
        element = element.rounded(px(props.corner_radius));
    }
    let element = element.children(children.iter().map(|child| render_node(child, events)));

    // Interactivity needs a stable element id; require the spec `id` for it.
    match (props.on_press, props.id.as_deref()) {
        (true, Some(id)) => {
            let node_id: SharedString = id.to_string().into();
            let events = events.clone();
            element
                .id(ElementId::Name(node_id.clone()))
                .on_click(move |_event, _window: &mut Window, _cx: &mut App| {
                    events.press(node_id.as_ref());
                })
                .into_any_element()
        }
        (true, None) => {
            eprintln!("[mirin-native] onPress requires an id; ignoring press handler");
            element.into_any_element()
        }
        (false, _) => element.into_any_element(),
    }
}

fn render_text(props: &TextProps, children: &[String]) -> AnyElement {
    let mut element = div().child(SharedString::from(children.concat()));
    if let Some(color) = props.color.as_deref().and_then(parse_color) {
        element = element.text_color(rgb(color));
    }
    if let Some(size) = props.size {
        element = element.text_size(px(size));
    }
    element.into_any_element()
}
