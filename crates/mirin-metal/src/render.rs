//! Tree → GPUI elements: turn a parsed `NodeSpec` into GPUI's element tree.
//! Per-frame mapping; layout/appearance state lives in the driver, exactly like
//! React Native's shadow tree → native views step. The one renderer-owned piece
//! of state is the editing buffer of `input` nodes (`window::InputState`).

use std::sync::OnceLock;

use gpui::{
    div, prelude::*, px, relative, rgba, AlignItems, AnyElement, App, ClickEvent, Context, Div,
    ElementId, FontWeight, MouseButton, MouseDownEvent, SharedString, Stateful, Window,
};

use crate::edges::{apply_box_edges, shadow_preset};
use crate::input::render_input;
use crate::media::{render_image, render_svg};
use crate::tree::{
    parse_color, Align, Direction, Justify, NodeSpec, TextAlign, TextProps, ViewProps, Weight,
};
use crate::window::RootView;

/// Render one node (and its subtree) into a GPUI element.
pub(crate) fn render_node(
    node: &NodeSpec,
    view: &mut RootView,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
    match node {
        NodeSpec::View { props, children } => render_view(props, children, view, window, cx),
        NodeSpec::Text { props, children } => render_text(props, children),
        NodeSpec::Input { props } => render_input(props, view, window, cx),
        NodeSpec::Svg { props } => render_svg(props),
        NodeSpec::Image { props } => render_image(props),
    }
}

/// A `div` carrying every layout and appearance prop of a view (not its
/// children, identity, or interaction).
fn styled_view(props: &ViewProps) -> Div {
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
    if let Some(padding) = props.padding_x {
        element = element.px(px(padding));
    }
    if let Some(padding) = props.padding_y {
        element = element.py(px(padding));
    }
    // Flex first: it zeroes the minimum size (so flex items can shrink below
    // their content), and explicit `minWidth`/`minHeight` below must win.
    if props.flex > 0.0 {
        element = flex_from_zero(element, props.flex);
    } else if props.grow > 0.0 {
        element.style().flex_grow = Some(props.grow);
        element = element.min_w(px(0.0)).min_h(px(0.0));
    }
    if let Some(width) = props.width {
        element = element.w(px(width));
    }
    if let Some(height) = props.height {
        element = element.h(px(height));
    }
    if let Some(width) = props.min_width {
        element = element.min_w(px(width));
    }
    if let Some(height) = props.min_height {
        element = element.min_h(px(height));
    }
    if let Some(width) = props.max_width {
        element = element.max_w(px(width));
    }
    if let Some(height) = props.max_height {
        element = element.max_h(px(height));
    }
    if props.relative {
        element = element.relative();
    }
    if props.absolute {
        element = element.absolute();
        if let Some(top) = props.top {
            element = element.top(px(top));
        }
        if let Some(left) = props.left {
            element = element.left(px(left));
        }
        if let Some(right) = props.right {
            element = element.right(px(right));
        }
        if let Some(bottom) = props.bottom {
            element = element.bottom(px(bottom));
        }
    }
    if props.shrink == Some(false) {
        element = element.flex_shrink_0();
    }
    if let Some(fraction) = props.width_percent {
        element = element.w(relative(fraction));
    }
    if let Some(fraction) = props.height_percent {
        element = element.h(relative(fraction));
    }
    if let Some(ratio) = props.aspect_ratio {
        element.style().aspect_ratio = Some(ratio);
    }
    if props.wrap {
        element = element.flex_wrap();
    }
    if let Some(align) = props.align_self {
        element.style().align_self = Some(match align {
            Align::Start => AlignItems::FlexStart,
            Align::Center => AlignItems::Center,
            Align::End => AlignItems::FlexEnd,
            Align::Stretch => AlignItems::Stretch,
        });
    }
    if props.occlude {
        element = element.block_mouse_except_scroll();
    }
    if props.fill {
        element = element.size_full();
    }
    if props.center {
        element = element.items_center().justify_center();
    }
    element = match props.align {
        Some(Align::Start) => element.items_start(),
        Some(Align::Center) => element.items_center(),
        Some(Align::End) => element.items_end(),
        Some(Align::Stretch) | None => element,
    };
    element = match props.justify {
        Some(Justify::Start) => element.justify_start(),
        Some(Justify::Center) => element.justify_center(),
        Some(Justify::End) => element.justify_end(),
        Some(Justify::Between) => element.justify_between(),
        None => element,
    };
    if let Some(color) = props.background.as_deref().and_then(parse_color) {
        element = element.bg(rgba(color));
    }
    if props.corner_radius > 0.0 {
        element = element.rounded(px(props.corner_radius));
    }
    if props.border_width >= 2.0 {
        element = element.border_2();
    } else if props.border_width >= 1.0 {
        element = element.border_1();
    }
    apply_box_edges(&mut element, props);
    crate::grid::apply_grid(&mut element, props);
    if let Some(color) = props.border_color.as_deref().and_then(parse_color) {
        element = element.border_color(rgba(color));
    }
    if let Some(shadow) = props.shadow.as_deref() {
        element.style().box_shadow = Some(shadow_preset(shadow));
    }
    if props.clip {
        element = element.overflow_hidden();
    }
    if let Some(opacity) = props.opacity {
        element = element.opacity(opacity);
    }
    element
}

fn render_view(
    props: &ViewProps,
    children: &[NodeSpec],
    view: &mut RootView,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let element = styled_view(props);
    if crate::list::virtualizes(props, children) {
        return crate::list::render_list(element, props, view, cx);
    }
    let child_ids: Vec<Option<String>> = children.iter().map(node_id).collect();
    let child_watch: Vec<bool> = children.iter().map(watches_layout).collect();
    let mut element = element.children(
        children
            .iter()
            .map(|child| render_node(child, view, window, cx)),
    );
    if child_ids.iter().any(Option::is_some) {
        let layout = view.layout.clone();
        let events = view.events.clone();
        element = element.on_children_prepainted(move |bounds, _window, _cx| {
            for ((id, watch), bounds) in child_ids.iter().zip(&child_watch).zip(bounds) {
                if let Some(id) = id {
                    record_child_bounds(&layout, &events, id, *watch, bounds);
                }
            }
        });
    }

    // Interaction and scrolling need a stable element id.
    let Some(id) = props.id.as_deref() else {
        if props.on_press
            || props.on_hover
            || props.on_pointer
            || props.on_context_menu
            || props.drag_region
            || props.scroll
            || props.scroll_x
            || props.hover_background.is_some()
        {
            eprintln!(
                "[mirin-metal] onPress/dragRegion/scroll/hoverBackground require an id; ignoring"
            );
        }
        return element.into_any_element();
    };
    let node_id: SharedString = id.to_string().into();
    let mut element: Stateful<Div> = element.id(ElementId::Name(node_id.clone()));
    if props.scroll {
        element = element.overflow_y_scroll();
    }
    if props.scroll_x {
        element = element.overflow_x_scroll();
    }
    if props.scroll || props.scroll_x {
        let handle = view.scrolls.entry(id.to_string()).or_default();
        element = element.track_scroll(handle);
        if props.scroll {
            let handle = handle.clone();
            let activity = view.scroll_activity.entry(id.to_string()).or_default().clone();
            element = element.child(crate::scrollbar::vertical(handle, activity));
        }
    }
    if let Some(color) = props.hover_background.as_deref().and_then(parse_color) {
        element = element.hover(move |style| style.bg(rgba(color)));
    }
    if props.on_hover {
        let events = view.events.clone();
        let hover_id = node_id.clone();
        element = element.on_hover(move |hovered: &bool, _window: &mut Window, _cx: &mut App| {
            events.hover(hover_id.as_ref(), *hovered);
        });
    }
    if props.on_pointer {
        let pointer_id = id.to_string();
        element = element.on_mouse_down(
            MouseButton::Left,
            cx.listener(move |view, event: &MouseDownEvent, _window, _cx| {
                view.press_claimed = true;
                view.dragging = Some(pointer_id.clone());
                view.emit_pointer(&pointer_id, "down", event.position);
            }),
        );
    }
    if props.on_context_menu {
        let menu_id = id.to_string();
        let events = view.events.clone();
        element = element.on_mouse_down(
            MouseButton::Right,
            move |event: &MouseDownEvent, _window: &mut Window, _cx: &mut App| {
                events.context_menu(
                    &menu_id,
                    f32::from(event.position.x),
                    f32::from(event.position.y),
                );
            },
        );
    }
    if props.on_press {
        let events = view.events.clone();
        // Pressing a button inside a drag region is a click, not a move.
        element = element.on_mouse_down(
            MouseButton::Left,
            cx.listener(|view, _event: &MouseDownEvent, _window, _cx| view.press_claimed = true),
        );
        element = element.cursor_pointer().on_click(
            move |_event: &ClickEvent, _window: &mut Window, _cx: &mut App| {
                events.press(node_id.as_ref());
            },
        );
    }
    if props.drag_region {
        // Like a title bar: a press starts a compositor-driven move (the
        // pointer grab goes to the compositor, `xdg_toplevel.move`), a
        // double click zooms. Listeners run deepest first, so a descendant
        // that took the press has already said so (`press_claimed`).
        element = element.on_mouse_down(
            MouseButton::Left,
            cx.listener(|view, event: &MouseDownEvent, window, _cx| {
                if view.press_claimed {
                    return;
                }
                if event.click_count >= 2 {
                    window.zoom_window();
                } else {
                    window.start_window_move();
                }
            }),
        );
    }
    element.into_any_element()
}

/// CSS `flex: N 1 0%` / React Native `flex: N`: grow from a zero basis. The 0%
/// basis lets taffy skip measuring the subtree for its base size (each nested
/// content-based grow costs another full layout of the subtree); against an
/// indefinite container a percentage basis falls back to content, as in CSS.
pub(crate) fn flex_from_zero<E: Styled>(mut element: E, flex: f32) -> E {
    let style = element.style();
    style.flex_grow = Some(flex);
    style.flex_shrink = Some(1.0);
    style.flex_basis = Some(relative(0.0).into());
    element.min_w(px(0.0)).min_h(px(0.0))
}

/// Record a painted child's bounds; report a `layout` event when a watched
/// node's bounds changed.
pub(crate) fn record_child_bounds(
    layout: &crate::sim::LayoutMap,
    events: &crate::events::EventSender,
    id: &str,
    watch: bool,
    bounds: gpui::Bounds<gpui::Pixels>,
) {
    if layout.record(id, bounds) && watch {
        events.resize(id);
    }
}

/// Whether a node asked for `layout` events when its bounds change.
pub(crate) fn watches_layout(node: &NodeSpec) -> bool {
    matches!(node, NodeSpec::View { props, .. } if props.on_layout && props.id.is_some())
}

/// The id a node carries, if any (views may omit one; inputs always have one).
pub(crate) fn node_id(node: &NodeSpec) -> Option<String> {
    match node {
        NodeSpec::View { props, .. } => props.id.clone(),
        NodeSpec::Text { .. } | NodeSpec::Svg { .. } | NodeSpec::Image { .. } => None,
        NodeSpec::Input { props } => Some(props.id.clone()),
    }
}

fn render_text(props: &TextProps, children: &[String]) -> AnyElement {
    let mut element = div().child(SharedString::from(children.concat()));
    if let Some(color) = props.color.as_deref().and_then(parse_color) {
        element = element.text_color(rgba(color));
    }
    if let Some(size) = props.size {
        element = element.text_size(px(size));
    }
    element = match props.weight {
        Weight::Normal => element,
        Weight::Medium => element.font_weight(FontWeight::MEDIUM),
        Weight::Semibold => element.font_weight(FontWeight::SEMIBOLD),
        Weight::Bold => element.font_weight(FontWeight::BOLD),
    };
    if props.mono {
        element = element.font_family(mono_family());
    }
    if props.truncate {
        element = element
            .w_full()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis();
    }
    if let Some(opacity) = props.opacity {
        element = element.opacity(opacity);
    }
    element = match props.align {
        Some(TextAlign::Center) => element.text_center(),
        Some(TextAlign::Right) => element.text_right(),
        Some(TextAlign::Left) | None => element,
    };
    if props.italic {
        element = element.italic();
    }
    if props.underline {
        element = element.underline();
    }
    if props.line_through {
        element = element.line_through();
    }
    if let Some(height) = props.line_height {
        element = element.line_height(px(height));
    }
    element.into_any_element()
}

/// The system UI sans family (Tailwind's `font-sans` is the system stack),
/// resolved once through fontconfig; `MIRIN_METAL_FONT` overrides it. GPUI's
/// own default (IBM Plex Sans) is rarely installed, and its fallback face has
/// no weights, so `font-semibold`/`font-bold` would not render.
pub(crate) fn sans_family() -> SharedString {
    static FAMILY: OnceLock<SharedString> = OnceLock::new();
    FAMILY
        .get_or_init(|| {
            if let Ok(family) = std::env::var("MIRIN_METAL_FONT") {
                if !family.trim().is_empty() {
                    return family.trim().to_string().into();
                }
            }
            fontconfig_family("sans-serif").unwrap_or_else(|| ".SystemUIFont".into())
        })
        .clone()
}

fn fontconfig_family(pattern: &str) -> Option<SharedString> {
    std::process::Command::new("fc-match")
        .args(["-f", "%{family}", pattern])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|family| {
            family
                .split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string()
        })
        .filter(|family| !family.is_empty())
        .map(SharedString::from)
}

/// The system monospace family, resolved once through fontconfig so `mono`
/// text matches what terminals on this desktop use. Falls back to a generic
/// name GPUI can usually resolve.
pub(crate) fn mono_family() -> SharedString {
    static FAMILY: OnceLock<SharedString> = OnceLock::new();
    FAMILY
        .get_or_init(|| {
            let detected = std::process::Command::new("fc-match")
                .args(["-f", "%{family}", "monospace"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|family| {
                    family
                        .split(',')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_string()
                })
                .filter(|family| !family.is_empty());
            detected.unwrap_or_else(|| "monospace".to_string()).into()
        })
        .clone()
}
