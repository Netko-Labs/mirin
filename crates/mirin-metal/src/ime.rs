//! Input methods in `input` nodes: the focused field's GPUI `InputHandler`,
//! which an input method (Fcitx 5, IBus; text-input-v3 on Wayland) composes
//! and commits text through, and asks where the caret is to put its
//! candidates under it.
//!
//! The handler is set while painting the focused field, never a secure one:
//! a password field takes no input method (GPUI turns text input off while
//! no handler is set; vendor/gpui/MIRIN.md), so what is typed there never
//! reaches one. Plain typing still arrives as keys (`input.rs`); a commit
//! of one ASCII character does too (GPUI on Wayland), so it edits exactly as
//! that key would.

use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    px, App, Bounds, Entity, InputHandler, Pixels, Point, TextLayout, UTF16Selection, Window,
};

use crate::caret::caret_bar;
use crate::field::Field;
use crate::window::RootView;

/// In the host binary while it has input methods in its fields (Dashi's
/// check for a patched host; the trace line names it once).
pub(crate) const IME_MARKER: &str = "MIRIN_METAL_IME";

/// The caret's width as reported to the input method.
const CARET_WIDTH: f32 = 2.0;

/// The focused field's input handler for one frame.
pub(crate) struct FieldInput {
    pub(crate) view: Entity<RootView>,
    pub(crate) id: String,
    pub(crate) multiline: bool,
    pub(crate) on_change: bool,
    /// The field as this frame drew it, its drawn text (the document), and
    /// that text's layout: where a document offset is on screen.
    pub(crate) drawn: Field,
    pub(crate) text: String,
    pub(crate) layout: TextLayout,
}

impl FieldInput {
    fn read<T>(&self, cx: &App, read: impl FnOnce(&Field) -> T) -> Option<T> {
        self.view
            .read(cx)
            .inputs
            .get(&self.id)
            .map(|state| read(&state.field))
    }

    /// Apply an input method's edit; the text changing is reported as typing is.
    fn edit(&self, cx: &mut App, edit: impl FnOnce(&mut Field) -> bool) {
        let (id, on_change) = (self.id.clone(), self.on_change);
        self.view.update(cx, |view, cx| {
            let Some(state) = view.inputs.get_mut(&id) else {
                return;
            };
            if edit(&mut state.field) {
                trace_once();
                if on_change {
                    view.report_change(&id);
                }
            }
            view.report_selection(&id);
            cx.notify();
        });
    }

    /// The caret-sized rect at a document offset, in window coordinates.
    pub(crate) fn caret_at(&self, offset_utf16: usize) -> Option<Bounds<Pixels>> {
        caret_rect(
            &self.layout,
            &self.text,
            self.drawn.display_byte(offset_utf16),
        )
    }
}

/// The caret-sized rect before byte `index` of a laid-out text: where the
/// caret is drawn (`caret.rs`).
pub(crate) fn caret_rect(layout: &TextLayout, text: &str, index: usize) -> Option<Bounds<Pixels>> {
    caret_bar(layout, text, index, px(CARET_WIDTH))
}

fn trace_once() {
    thread_local!(static TRACED: Cell<bool> = const { Cell::new(false) });
    if !TRACED.with(|traced| traced.replace(true)) {
        crate::trace::log(format_args!("{IME_MARKER}: an input method edited a field"));
    }
}

impl InputHandler for FieldInput {
    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<UTF16Selection> {
        self.read(cx, |field| UTF16Selection {
            range: field.selected_utf16(),
            reversed: field.preedit.is_none() && field.is_reversed(),
        })
    }

    fn marked_text_range(&mut self, _window: &mut Window, cx: &mut App) -> Option<Range<usize>> {
        self.read(cx, Field::marked_utf16).flatten()
    }

    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _adjusted_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<String> {
        self.read(cx, |field| field.text_for_utf16(range_utf16))
    }

    fn replace_text_in_range(
        &mut self,
        replacement_range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut App,
    ) {
        let multiline = self.multiline;
        self.edit(cx, |field| {
            field.replace_utf16(replacement_range, text, multiline)
        });
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut App,
    ) {
        self.edit(cx, |field| {
            // A range other than the composition's is text to compose over.
            let replaced = match range_utf16 {
                Some(range) if Some(&range) != field.marked_utf16().as_ref() => {
                    field.replace_utf16(Some(range), "", false)
                }
                _ => false,
            };
            field.compose(new_text) || replaced
        });
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut App) {
        let multiline = self.multiline;
        self.edit(cx, |field| field.unmark(multiline));
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        self.caret_at(range_utf16.start)
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<usize> {
        // Metal's fields have no pointer placement.
        None
    }
}

/// Where the caret was last told to the input method, per field: told
/// again only when it moves.
pub(crate) type CaretReported = Rc<Cell<Option<Bounds<Pixels>>>>;
