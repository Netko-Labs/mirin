//! The `input` node: a text field whose editing state (buffer, caret,
//! focus, select-all) lives in the renderer. The driver sees `change` and
//! `submit` events and may reset the contents through `value`.

use gpui::{
    div, prelude::*, px, rgba, AnyElement, App, Context, ElementId, KeyDownEvent, MouseButton,
    MouseDownEvent, SharedString, Window,
};

use crate::render::mono_family;
use crate::tree::{parse_color, InputProps};
use crate::window::RootView;

/// Caret glyph drawn at the cursor while the input has focus.
const CARET: &str = "\u{258F}";

pub(crate) fn render_input(
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
    // Flex first so an explicit `minHeight` below wins over its zero minimum.
    if props.flex > 0.0 {
        element = crate::render::flex_from_zero(element, props.flex);
    }
    if let Some(width) = props.width {
        element = element.w(px(width));
    }
    if let Some(fraction) = props.width_percent {
        element = element.w(gpui::relative(fraction));
    }
    if let Some(height) = props.height {
        element = element.h(px(height));
    }
    if let Some(height) = props.min_height {
        element = element.min_h(px(height));
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
    let on_key = props.on_key;
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
            Edit::Key(key) => {
                if on_key {
                    view.events.key(&key_id, key);
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
    /// A navigation key the driver may act on (`onKey`).
    Key(&'static str),
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
        "escape" => Edit::Key("Escape"),
        "up" => Edit::Key("ArrowUp"),
        "down" => Edit::Key("ArrowDown"),
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
