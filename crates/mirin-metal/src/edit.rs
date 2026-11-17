//! A field's text and selection set from outside the keyboard: an agent's
//! or a screen reader's `SetTextContents`, `InsertText`, `DeleteText`,
//! `SetCaretOffset` and `SetSelection` over AT-SPI (`access/`), and the
//! `settext` and `inserttext` simulations. Each is done as typing it would
//! be: the same cleaning of what is put in (`Field::commit`: no line breaks
//! in a one-line field), the driver told (`change`, then `selection`), and
//! the field drawn again. The keyboard stays where it is: a field without
//! it is set all the same.

use sumi::Context;

use crate::tree::NodeSpec;
use crate::window::RootView;

/// What is done to a field's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FieldEdit {
    /// All it holds becomes this; the caret goes to its end.
    Set(String),
    /// What is selected (nothing: the caret's place) becomes this; the caret
    /// goes after it.
    Insert(String),
    /// Select from the first char to the second, the caret at the second.
    Select(usize, usize),
}

impl RootView {
    /// Do `edit` to field `id`, as typing would.
    pub(crate) fn edit_field(&mut self, id: &str, edit: FieldEdit, cx: &mut Context<Self>) {
        let Some(NodeSpec::Input { props }) = self.tree.find(id) else {
            eprintln!("[mirin-metal] field edit: no field with id {id:?}");
            return;
        };
        let (multiline, on_change) = (props.multiline, props.on_change);
        let Some(state) = self.inputs.get_mut(id) else {
            return;
        };
        let field = &mut state.field;
        let changed = match edit {
            FieldEdit::Set(text) => {
                // Over a composition too: what an input method was composing
                // is dropped with the rest of the text.
                field.preedit = None;
                field.select_all();
                field.commit(&text, multiline)
            }
            FieldEdit::Insert(text) => {
                field.preedit = None;
                field.commit(&text, multiline)
            }
            FieldEdit::Select(anchor, focus) => {
                field.select(anchor, focus);
                false
            }
        };
        if changed && on_change {
            self.report_change(id);
        }
        self.report_selection(id);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use crate::field::Field;

    /// What `edit_field` does to the model, without a window.
    fn set(field: &mut Field, text: &str, multiline: bool) -> bool {
        field.preedit = None;
        field.select_all();
        field.commit(text, multiline)
    }

    #[test]
    fn a_set_replaces_everything_and_puts_the_caret_at_the_end() {
        let mut field = Field::new("draft");
        field.place(2);
        assert!(set(&mut field, "Drafts", false));
        assert_eq!(field.buffer, "Drafts");
        assert_eq!(field.ends(), (6, 6));
    }

    #[test]
    fn a_one_line_field_takes_no_line_breaks() {
        let mut field = Field::new("");
        set(&mut field, "two\nlines", false);
        assert!(!field.buffer.contains('\n'));
        let mut note = Field::new("");
        set(&mut note, "two\nlines", true);
        assert_eq!(note.buffer, "two\nlines");
    }

    #[test]
    fn an_insert_replaces_the_selection_and_a_select_moves_the_caret() {
        let mut field = Field::new("hello world");
        field.select(6, 11);
        assert!(field.commit("there", false));
        assert_eq!(field.buffer, "hello there");
        assert_eq!(field.ends(), (11, 11));
        field.select(0, 5);
        assert_eq!(field.ends(), (0, 5));
        // A delete is an insert of nothing over a selection.
        assert!(field.commit("", false));
        assert_eq!(field.buffer, " there");
    }
}
