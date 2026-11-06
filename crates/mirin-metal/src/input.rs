//! The `input` node: a text field whose editing state (buffer, caret,
//! focus, select-all, an input method's composition) lives in the renderer.
//! The driver sees `change` and `submit` events and may reset the contents
//! through `value`. The editing itself is `field.rs`; input methods reach
//! the field through `ime.rs`.

use std::rc::Rc;

use gpui::{
    div, prelude::*, px, rgba, AnyElement, Context, ElementId, HighlightStyle, KeyDownEvent,
    MouseButton, MouseDownEvent, SharedString, StyledText, UnderlineStyle, Window,
};

use crate::field::Edit;
use crate::ime::{caret_rect, CaretReported, FieldInput};
use crate::render::mono_family;
use crate::tree::{parse_color, InputProps};
use crate::window::RootView;

pub(crate) fn render_input(
    props: &InputProps,
    view: &mut RootView,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let Some(state) = view.inputs.get_mut(&props.id) else {
        // `sync_inputs` always runs before render; reaching here is a bug.
        return div().into_any_element();
    };
    let focused = state.focus.is_focused(window);
    if !focused {
        // A composition belongs to the field with the keyboard; the caret
        // is told again when it comes back.
        state.field.preedit = None;
        state.caret_reported.set(None);
    }
    let state = &view.inputs[&props.id];
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

    // Content: the buffer with a caret at the cursor (and an input method's
    // composition before it, underlined), or the placeholder.
    let field = &state.field;
    let showing_placeholder = field.buffer.is_empty() && !focused;
    let (content, composition, caret) = if showing_placeholder {
        (props.placeholder.clone().unwrap_or_default(), None, None)
    } else {
        let display = field.display(focused, props.secure);
        (display.text, display.composition, display.caret)
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
    let text =
        StyledText::new(SharedString::from(content)).with_highlights(composition.map(|range| {
            let underline = UnderlineStyle {
                thickness: px(1.0),
                color: None,
                wavy: false,
            };
            let style = HighlightStyle {
                underline: Some(underline),
                ..HighlightStyle::default()
            };
            (range, style)
        }));
    let layout = text.layout().clone();
    let mut body = div().child(text);
    // Empty and focused: the placeholder stays, muted, right after the caret,
    // until the first character replaces it (as a search field's hint does).
    let hint = props.placeholder.as_deref().filter(|hint| {
        focused && field.buffer.is_empty() && field.preedit.is_none() && !hint.is_empty()
    });
    if let Some(hint) = hint {
        let mut placeholder = div().child(SharedString::from(hint.to_owned()));
        if let Some(color) = props.placeholder_color.as_deref().and_then(parse_color) {
            placeholder = placeholder.text_color(rgba(color));
        }
        body = div().flex().flex_row().child(body).child(placeholder);
    }
    if props.multiline {
        body = body.size_full().whitespace_normal();
    }
    element = element.child(body);

    // The focused field takes an input method's text (never a secure one).
    if focused && !props.secure {
        let handler = FieldInput {
            view: cx.entity(),
            id: props.id.clone(),
            multiline: props.multiline,
            on_change: props.on_change,
            drawn: field.clone(),
            layout,
        };
        let focus = state.focus.clone();
        let reported = Rc::clone(&state.caret_reported);
        element = element.child(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), window, cx| {
                    let at = caret.and_then(|index| caret_rect(&handler.layout, index));
                    window.handle_input(&focus, handler, cx);
                    tell_caret(&reported, at, window);
                },
            )
            .absolute()
            .size_0(),
        );
    }

    // Click focuses; keys edit the buffer.
    let focus_id = props.id.clone();
    element = element.on_mouse_down(
        MouseButton::Left,
        cx.listener(move |view, _event: &MouseDownEvent, window, cx| {
            view.press_claimed = true;
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
            let paste = || cx.read_from_clipboard().and_then(|item| item.text());
            state.field.key(&event.keystroke, multiline, paste)
        };
        // A key the field took stops here: the text it typed must not reach
        // the input handler as well (GPUI hands an unhandled key's text to it).
        if !matches!(outcome, Edit::None | Edit::Key(_)) {
            cx.stop_propagation();
        }
        match outcome {
            Edit::None => {}
            Edit::FocusNext => view.focus_neighbor(&key_id, 1, window),
            Edit::FocusPrevious => view.focus_neighbor(&key_id, -1, window),
            Edit::Changed => {
                if on_change {
                    view.report_change(&key_id);
                }
                cx.notify();
            }
            Edit::Submitted => {
                if on_submit {
                    if let Some(state) = view.inputs.get(&key_id) {
                        view.events.submit(&key_id, &state.field.buffer);
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

/// Tell the input method where the caret is when it has moved (or the field
/// just took the keyboard), for its candidates to go under it.
fn tell_caret(reported: &CaretReported, at: Option<gpui::Bounds<gpui::Pixels>>, window: &Window) {
    if at.is_some() && reported.replace(at) != at {
        window.invalidate_character_coordinates();
    }
}
