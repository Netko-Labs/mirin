//! Tree → GPUI elements: turn a parsed `NodeSpec` into GPUI's element tree.
//! Per-frame mapping; layout/appearance state lives in the driver, exactly like
//! React Native's shadow tree → native views step. The one renderer-owned piece
//! of state is the editing buffer of `input` nodes (`window::InputState`).

use std::sync::OnceLock;

use gpui::{
    div, prelude::*, px, rgba, AnyElement, App, ClickEvent, Context, Div, ElementId, FontWeight,
    KeyDownEvent, MouseButton, MouseDownEvent, SharedString, Stateful, Window,
};

use crate::tree::{
    parse_color, Align, Direction, InputProps, Justify, NodeSpec, TextProps, ViewProps, Weight,
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
    }
}

fn render_view(
    props: &ViewProps,
    children: &[NodeSpec],
    view: &mut RootView,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
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
    if let Some(height) = props.max_height {
        element = element.max_h(px(height));
    }
    if props.flex >= 1.0 {
        element = element.flex_grow().min_w(px(0.0)).min_h(px(0.0));
    }
    if props.shrink == Some(false) {
        element = element.flex_shrink_0();
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
    if let Some(color) = props.border_color.as_deref().and_then(parse_color) {
        element = element.border_color(rgba(color));
    }
    if props.clip {
        element = element.overflow_hidden();
    }
    if let Some(opacity) = props.opacity {
        element = element.opacity(opacity);
    }
    let child_ids: Vec<Option<String>> = children.iter().map(node_id).collect();
    let mut element = element.children(
        children
            .iter()
            .map(|child| render_node(child, view, window, cx)),
    );
    if child_ids.iter().any(Option::is_some) {
        let layout = view.layout.clone();
        element = element.on_children_prepainted(move |bounds, _window, _cx| {
            for (id, bounds) in child_ids.iter().zip(bounds) {
                if let Some(id) = id {
                    layout.record(id, bounds);
                }
            }
        });
    }

    // Interaction and scrolling need a stable element id.
    let Some(id) = props.id.as_deref() else {
        if props.on_press || props.scroll || props.scroll_x || props.hover_background.is_some() {
            eprintln!("[mirin-metal] onPress/scroll/hoverBackground require an id; ignoring");
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
    if let Some(color) = props.hover_background.as_deref().and_then(parse_color) {
        element = element.hover(move |style| style.bg(rgba(color)));
    }
    if props.on_press {
        let events = view.events.clone();
        element = element.cursor_pointer().on_click(
            move |_event: &ClickEvent, _window: &mut Window, _cx: &mut App| {
                events.press(node_id.as_ref());
            },
        );
    }
    element.into_any_element()
}

/// The id a node carries, if any (views may omit one; inputs always have one).
fn node_id(node: &NodeSpec) -> Option<String> {
    match node {
        NodeSpec::View { props, .. } => props.id.clone(),
        NodeSpec::Text { .. } => None,
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
    element.into_any_element()
}

/// Caret glyph drawn at the cursor while the input has focus.
const CARET: &str = "\u{258F}";

fn render_input(
    props: &InputProps,
    view: &mut RootView,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let Some(state) = view.inputs.get(&props.id) else {
        // `sync_inputs` always runs before render; reaching here is a bug.
        return div().into_any_element();
    };
    let focused = state.focus.is_focused(window);
    let node_id: SharedString = props.id.clone().into();

    let mut element = div()
        .id(ElementId::Name(node_id.clone()))
        .track_focus(&state.focus)
        .cursor_text()
        .flex()
        .flex_col();
    if props.multiline {
        element = element.items_start().justify_start();
    } else {
        element = element
            .justify_center()
            .whitespace_nowrap()
            .overflow_hidden();
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
    if let Some(height) = props.min_height {
        element = element.min_h(px(height));
    }
    if props.flex >= 1.0 {
        element = element.flex_grow().min_w(px(0.0)).min_h(px(0.0));
    }
    if props.fill {
        element = element.size_full();
    }
    if let Some(color) = props.background.as_deref().and_then(parse_color) {
        element = element.bg(rgba(color));
    }
    if props.corner_radius > 0.0 {
        element = element.rounded(px(props.corner_radius));
    }
    let border = if focused {
        props
            .focus_border_color
            .as_deref()
            .or(props.border_color.as_deref())
    } else {
        props.border_color.as_deref()
    };
    if let Some(color) = border.and_then(parse_color) {
        element = element.border_1().border_color(rgba(color));
    }
    if let Some(size) = props.size {
        element = element.text_size(px(size));
    }
    if props.mono {
        element = element.font_family(mono_family());
    }

    // Content: the buffer with a caret at the cursor, or the placeholder.
    let showing_placeholder = state.buffer.is_empty() && !focused;
    let content: String = if showing_placeholder {
        props.placeholder.clone().unwrap_or_default()
    } else {
        let mut text = String::with_capacity(state.buffer.len() + CARET.len());
        for (index, ch) in state.buffer.chars().enumerate() {
            if focused && index == state.cursor {
                text.push_str(CARET);
            }
            text.push(if props.secure { '\u{2022}' } else { ch });
        }
        if focused && state.cursor >= state.buffer.chars().count() {
            text.push_str(CARET);
        }
        text
    };
    let color = if showing_placeholder {
        props
            .placeholder_color
            .as_deref()
            .or(props.color.as_deref())
    } else {
        props.color.as_deref()
    };
    if let Some(color) = color.and_then(parse_color) {
        element = element.text_color(rgba(color));
    }
    let mut body = div().child(SharedString::from(content));
    if props.multiline {
        body = body.size_full().whitespace_normal();
    }
    element = element.child(body);

    // Click focuses; keys edit the buffer.
    let focus_id = props.id.clone();
    element = element.on_mouse_down(
        MouseButton::Left,
        cx.listener(move |view, _event: &MouseDownEvent, window, cx| {
            if let Some(state) = view.inputs.get(&focus_id) {
                window.focus(&state.focus);
            }
            cx.notify();
        }),
    );
    let key_id = props.id.clone();
    let multiline = props.multiline;
    let on_change = props.on_change;
    let on_submit = props.on_submit;
    element = element.on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
        let outcome = {
            let Some(state) = view.inputs.get_mut(&key_id) else {
                return;
            };
            edit(state, event, multiline, cx)
        };
        match outcome {
            Edit::None => {}
            Edit::FocusNext => view.focus_neighbor(&key_id, 1, window),
            Edit::FocusPrevious => view.focus_neighbor(&key_id, -1, window),
            Edit::Changed => {
                if on_change {
                    if let Some(state) = view.inputs.get(&key_id) {
                        view.events.change(&key_id, &state.buffer);
                    }
                }
                cx.notify();
            }
            Edit::Submitted => {
                if on_submit {
                    if let Some(state) = view.inputs.get(&key_id) {
                        view.events.submit(&key_id, &state.buffer);
                    }
                }
            }
        }
    }));

    element.into_any_element()
}

enum Edit {
    None,
    Changed,
    Submitted,
    FocusNext,
    FocusPrevious,
}

/// Apply one keystroke to an input buffer.
fn edit(
    state: &mut crate::window::InputState,
    event: &KeyDownEvent,
    multiline: bool,
    cx: &App,
) -> Edit {
    let keystroke = &event.keystroke;
    let modifiers = keystroke.modifiers;
    let command = modifiers.control || modifiers.platform;
    let len = state.buffer.chars().count();
    state.cursor = state.cursor.min(len);
    if state.select_all {
        state.select_all = false;
        match keystroke.key.as_str() {
            "backspace" | "delete" => {
                state.buffer.clear();
                state.cursor = 0;
                return Edit::Changed;
            }
            "left" | "home" => {
                state.cursor = 0;
                return Edit::Changed;
            }
            "right" | "end" => {
                state.cursor = len;
                return Edit::Changed;
            }
            "enter" | "tab" | "escape" | "up" | "down" => {}
            _ if command => {}
            _ => {
                // Typing over a selection replaces it.
                state.buffer.clear();
                state.cursor = 0;
            }
        }
    }
    let len = state.buffer.chars().count();
    match keystroke.key.as_str() {
        "backspace" => {
            if state.cursor == 0 {
                return Edit::None;
            }
            remove_char(state, state.cursor - 1);
            state.cursor -= 1;
            Edit::Changed
        }
        "delete" => {
            if state.cursor >= len {
                return Edit::None;
            }
            remove_char(state, state.cursor);
            Edit::Changed
        }
        "left" => {
            state.cursor = state.cursor.saturating_sub(1);
            Edit::Changed
        }
        "right" => {
            state.cursor = (state.cursor + 1).min(len);
            Edit::Changed
        }
        "home" => {
            state.cursor = 0;
            Edit::Changed
        }
        "end" => {
            state.cursor = len;
            Edit::Changed
        }
        "enter" => {
            if multiline && !command {
                insert_str(state, "\n");
                Edit::Changed
            } else {
                Edit::Submitted
            }
        }
        "tab" => {
            if modifiers.shift {
                Edit::FocusPrevious
            } else {
                Edit::FocusNext
            }
        }
        "v" if command => match cx.read_from_clipboard().and_then(|item| item.text()) {
            Some(text) => {
                let text = if multiline {
                    text
                } else {
                    text.replace('\n', " ")
                };
                insert_str(state, &text);
                Edit::Changed
            }
            None => Edit::None,
        },
        "a" if command => {
            state.select_all = true;
            state.cursor = len;
            Edit::Changed
        }
        "space" => {
            insert_str(state, " ");
            Edit::Changed
        }
        _ => {
            if command {
                return Edit::None;
            }
            match keystroke.key_char.as_deref() {
                Some(text) if !text.is_empty() && !text.chars().any(char::is_control) => {
                    insert_str(state, text);
                    Edit::Changed
                }
                _ => Edit::None,
            }
        }
    }
}

fn insert_str(state: &mut crate::window::InputState, text: &str) {
    let byte_index = char_to_byte(&state.buffer, state.cursor);
    state.buffer.insert_str(byte_index, text);
    state.cursor += text.chars().count();
}

fn remove_char(state: &mut crate::window::InputState, char_index: usize) {
    let start = char_to_byte(&state.buffer, char_index);
    let end = char_to_byte(&state.buffer, char_index + 1);
    state.buffer.replace_range(start..end, "");
}

fn char_to_byte(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(byte, _)| byte)
        .unwrap_or(text.len())
}

/// The system monospace family, resolved once through fontconfig so `mono`
/// text matches what terminals on this desktop use. Falls back to a generic
/// name GPUI can usually resolve.
fn mono_family() -> SharedString {
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
