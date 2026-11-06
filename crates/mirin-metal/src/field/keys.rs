//! What a keystroke does to a field.

use gpui::Keystroke;

use super::{Edit, Field};

impl Field {
    /// Apply one keystroke. `paste` reads the clipboard (Ctrl/Cmd+V). A key
    /// that edits ends a composition that is showing (an input method that
    /// takes the keyboard never lets one through mid-composition; a dead
    /// key's composition ends in the key that types the composed character).
    pub(crate) fn key(
        &mut self,
        keystroke: &Keystroke,
        multiline: bool,
        paste: impl FnOnce() -> Option<String>,
    ) -> Edit {
        let edit = self.apply_key(keystroke, multiline, paste);
        if edit != Edit::None {
            self.preedit = None;
        }
        edit
    }

    fn apply_key(
        &mut self,
        keystroke: &Keystroke,
        multiline: bool,
        paste: impl FnOnce() -> Option<String>,
    ) -> Edit {
        let modifiers = keystroke.modifiers;
        let command = modifiers.control || modifiers.platform;
        let len = self.len();
        self.cursor = self.cursor.min(len);
        if self.select_all {
            self.select_all = false;
            match keystroke.key.as_str() {
                "backspace" | "delete" => {
                    self.buffer.clear();
                    self.cursor = 0;
                    return Edit::Changed;
                }
                "left" | "home" => {
                    self.cursor = 0;
                    return Edit::Changed;
                }
                "right" | "end" => {
                    self.cursor = len;
                    return Edit::Changed;
                }
                "enter" | "tab" | "escape" | "up" | "down" => {}
                _ if command => {}
                _ => {
                    // Typing over a selection replaces it.
                    self.buffer.clear();
                    self.cursor = 0;
                }
            }
        }
        let len = self.len();
        match keystroke.key.as_str() {
            "backspace" => {
                if self.cursor == 0 {
                    return Edit::None;
                }
                self.remove_char(self.cursor - 1);
                self.cursor -= 1;
                Edit::Changed
            }
            "delete" => {
                if self.cursor >= len {
                    return Edit::None;
                }
                self.remove_char(self.cursor);
                Edit::Changed
            }
            "left" => {
                self.cursor = self.cursor.saturating_sub(1);
                Edit::Changed
            }
            "right" => {
                self.cursor = (self.cursor + 1).min(len);
                Edit::Changed
            }
            "home" => {
                self.cursor = 0;
                Edit::Changed
            }
            "end" => {
                self.cursor = len;
                Edit::Changed
            }
            "enter" => {
                if multiline && !command {
                    self.insert_str("\n");
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
            "v" if command => match paste() {
                Some(text) => {
                    let text = if multiline {
                        text
                    } else {
                        text.replace('\n', " ")
                    };
                    self.insert_str(&text);
                    Edit::Changed
                }
                None => Edit::None,
            },
            "a" if command => {
                self.select_all = true;
                self.cursor = len;
                Edit::Changed
            }
            "space" => {
                self.insert_str(" ");
                Edit::Changed
            }
            _ => {
                if command {
                    return Edit::None;
                }
                match keystroke.key_char.as_deref() {
                    Some(text) if !text.is_empty() && !text.chars().any(char::is_control) => {
                        self.insert_str(text);
                        Edit::Changed
                    }
                    _ => Edit::None,
                }
            }
        }
    }
}
