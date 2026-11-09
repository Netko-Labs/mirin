//! The `input` node: a text field whose editing state (buffer, caret,
//! selection, focus, an input method's composition) lives in the renderer.
//! The driver sees `change`, `submit`, and `selection` events and may reset
//! the contents through `value` and the selection through `selection`. The
//! editing itself is `field.rs`; the pointer and the driver's selection are
//! `selection.rs`; input methods reach the field through `ime.rs`.

use std::ops::Range;
use std::rc::Rc;

use gpui::{
    div, prelude::*, px, rgba, AnyElement, App, ClipboardItem, Context, ElementId, HighlightStyle,
    KeyDownEvent, MouseButton, MouseDownEvent, SharedString, StyledText, UnderlineStyle, Window,
};

use crate::caret::{paint_caret, paint_selection, Drawn};
use crate::field::{Clipboard, Display, Edit, KeyEnv, Lines};
use crate::ime::{caret_rect, CaretReported, FieldInput};
use crate::marks::{highlight_ranges, paint_highlights, paint_line_numbers};
use crate::render::mono_family;
use crate::selection::{follow_drag, PressProps};
use crate::tree::{parse_color, InputProps, TextAlign};
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
    // One line at the right edge sits there by layout; a longer one is
    // shifted to keep its caret in view (`follow.rs`).
    let at_right = !props.multiline && props.align == Some(TextAlign::Right);
    if props.multiline {
        element = element.items_start().justify_start();
    } else {
        element = element
            .justify_center()
            .whitespace_nowrap()
            .overflow_hidden();
        if at_right {
            element = element.items_end();
        }
    }
    if props.padding > 0.0 {
        element = element.p(px(props.padding));
    }
    // Line numbers take room at the text's left (`marks.rs`).
    let line_numbers = props
        .line_numbers
        .as_ref()
        .filter(|_| props.multiline && !props.secure)
        .and_then(|numbers| Some((numbers.width.max(0.0), parse_color(&numbers.color)?)));
    if let Some((width, _)) = line_numbers {
        element = element.pl(px(props.padding + width));
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

    // Content: the buffer (with an input method's composition at the caret,
    // underlined), or the placeholder. The selection's wash is painted
    // behind it and the caret over it, neither taking room in the text.
    let field = &state.field;
    let showing_placeholder = field.buffer.is_empty() && !focused;
    let display = if showing_placeholder {
        Display::plain(props.placeholder.clone().unwrap_or_default())
    } else {
        field.display(focused, props.secure)
    };
    let caret = display.caret;
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
    // The driver's runs (`runs.rs`) under the composition's underline; a
    // placeholder or a secure field's bullets are drawn plain.
    let styled = if showing_placeholder || props.secure || props.runs.is_empty() {
        crate::runs::Styled {
            highlights: highlights(&display),
            sizes: Vec::new(),
        }
    } else {
        crate::runs::style(
            &props.runs,
            &field.buffer,
            &display.text,
            &display.buffer_bytes(),
            highlights(&display).pop(),
        )
    };
    let mut text = StyledText::new(SharedString::from(display.text.clone()))
        .with_highlights(styled.highlights);
    if props.multiline && !styled.sizes.is_empty() {
        text = text.with_paragraph_sizes(styled.sizes);
    }
    let layout = text.layout().clone();
    // The driver's highlights, behind the text and under the selection.
    let marked = if showing_placeholder || props.secure {
        Vec::new()
    } else {
        highlight_ranges(&field.buffer, &display, &props.highlights)
    };
    if !marked.is_empty() {
        let (layout, shown) = (layout.clone(), display.text.clone());
        element = element.child(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), window, _| paint_highlights(&layout, &shown, &marked, window),
            )
            .absolute()
            .size_0(),
        );
    }
    if let Some((_, color)) = line_numbers {
        let (layout, shown) = (layout.clone(), display.text.clone());
        element = element.child(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), window, cx| {
                    paint_line_numbers(&layout, &shown, showing_placeholder, color, window, cx);
                },
            )
            .absolute()
            .size_0(),
        );
    }
    if let Some(range) = display.selection.clone() {
        let color = props
            .selection_color
            .as_deref()
            .and_then(parse_color)
            .unwrap_or(SELECTION_COLOR);
        let (layout, shown) = (layout.clone(), display.text.clone());
        element = element.child(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), window, _| {
                    paint_selection(&layout, &shown, range, rgba(color).into(), window);
                },
            )
            .absolute()
            .size_0(),
        );
    }
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
    } else {
        let shift = state.scroll.get();
        body = body.flex_none().relative().left(px(-shift));
        if at_right {
            body = body.mr(px(crate::follow::CARET_ROOM));
        }
    }
    element = element.child(body);
    if let Some(index) = caret {
        let (layout, shown) = (layout.clone(), display.text.clone());
        element = element.child(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), window, _| paint_caret(&layout, &shown, index, window),
            )
            .absolute()
            .size_0(),
        );
    }

    if !props.multiline {
        let (layout, shown, scroll) = (
            layout.clone(),
            display.text.clone(),
            Rc::clone(&state.scroll),
        );
        let padding = props.padding;
        element = element.child(
            gpui::canvas(
                |bounds, _, _| bounds,
                move |_, field, window, _| {
                    crate::follow::follow_after_paint(
                        &scroll, &layout, &shown, caret, field, padding, window,
                    );
                },
            )
            .absolute()
            .inset_0(),
        );
    }

    // What was drawn where, for the pointer and the arrows (`caret.rs`), and
    // the pointer wherever it goes, for a press that selects (`selection.rs`).
    let shown = display.text.clone();
    let drawn = Drawn {
        field: field.clone(),
        display,
        layout: layout.clone(),
        placeholder: showing_placeholder,
    };
    let cell = Rc::clone(&state.selection.drawn);
    let (view, id, multiline) = (cx.weak_entity(), props.id.clone(), props.multiline);
    element = element.child(
        gpui::canvas(
            |_, _, _| {},
            move |_, (), window, _| {
                cell.replace(Some(drawn));
                follow_drag(view, id, multiline, window);
            },
        )
        .absolute()
        .size_0(),
    );

    // The focused field takes an input method's text (never a secure one).
    if focused && !props.secure {
        let handler = FieldInput {
            view: cx.entity(),
            id: props.id.clone(),
            multiline: props.multiline,
            on_change: props.on_change,
            drawn: field.clone(),
            text: shown,
            layout,
        };
        let focus = state.focus.clone();
        let reported = Rc::clone(&state.caret_reported);
        element = element.child(
            gpui::canvas(
                |_, _, _| {},
                move |_, (), window, cx| {
                    let at =
                        caret.and_then(|index| caret_rect(&handler.layout, &handler.text, index));
                    window.handle_input(&focus, handler, cx);
                    tell_caret(&reported, at, window);
                },
            )
            .absolute()
            .size_0(),
        );
    }

    // A press focuses and places the caret (or selects); keys edit the buffer.
    let focus_id = props.id.clone();
    let press = PressProps {
        multiline: props.multiline,
        on_change: props.on_change,
        runs: props
            .runs
            .iter()
            .any(|run| run.press)
            .then(|| props.runs.clone()),
    };
    element = element.on_mouse_down(
        MouseButton::Left,
        cx.listener(move |view, event: &MouseDownEvent, window, cx| {
            view.press_claimed = true;
            if let Some(state) = view.inputs.get(&focus_id) {
                window.focus(&state.focus);
            }
            view.press_field(&focus_id, event, &press);
            cx.notify();
        }),
    );
    let key_id = props.id.clone();
    let multiline = props.multiline;
    let secure = props.secure;
    let on_change = props.on_change;
    let on_submit = props.on_submit;
    let next_on_submit = props.focus_next_on_submit;
    let on_key = props.on_key;
    element = element.on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
        let outcome = {
            let Some(state) = view.inputs.get_mut(&key_id) else {
                return;
            };
            // The drawn lines, while the field is still the one drawn.
            let drawn = state.selection.drawn.borrow();
            let lines = drawn
                .as_ref()
                .filter(|drawn| drawn.field.lays_out_as(&state.field))
                .map(|drawn| drawn as &dyn Lines);
            let mut clipboard = SystemClipboard(cx);
            let mut env = KeyEnv {
                multiline,
                secure,
                clipboard: &mut clipboard,
                lines,
            };
            state.field.key(&event.keystroke, &mut env)
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
                view.report_selection(&key_id);
                cx.notify();
            }
            Edit::Moved => {
                view.report_selection(&key_id);
                cx.notify();
            }
            Edit::Handled => {}
            Edit::Submitted => {
                if on_submit {
                    if let Some(state) = view.inputs.get(&key_id) {
                        view.events.submit(&key_id, &state.field.buffer);
                    }
                }
                // Before the driver hears of it: the next key already goes there.
                if next_on_submit {
                    view.focus_neighbor(&key_id, 1, window);
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

/// What a selection is drawn on without a `selectionColor`: a translucent blue.
const SELECTION_COLOR: u32 = 0x3584_e44d;

/// The composition, underlined (the selection and the caret are painted
/// beside the text, `caret.rs`).
fn highlights(display: &Display) -> Vec<(Range<usize>, HighlightStyle)> {
    let underline = UnderlineStyle {
        thickness: px(1.0),
        color: None,
        wavy: false,
    };
    let style = HighlightStyle {
        underline: Some(underline),
        ..HighlightStyle::default()
    };
    display
        .composition
        .clone()
        .map(|range| (range, style))
        .into_iter()
        .collect()
}

/// The system clipboard (Cut, Copy, Paste), as a field reads and writes it.
struct SystemClipboard<'a>(&'a App);

impl Clipboard for SystemClipboard<'_> {
    fn read(&mut self) -> Option<String> {
        self.0.read_from_clipboard().and_then(|item| item.text())
    }

    fn write(&mut self, text: &str) {
        self.0
            .write_to_clipboard(ClipboardItem::new_string(text.to_owned()));
    }
}

/// Tell the input method where the caret is when it has moved (or the field
/// just took the keyboard), for its candidates to go under it.
fn tell_caret(reported: &CaretReported, at: Option<gpui::Bounds<gpui::Pixels>>, window: &Window) {
    if at.is_some() && reported.replace(at) != at {
        window.invalidate_character_coordinates();
    }
}
