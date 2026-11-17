// Copyright 2026 The AccessKit Authors. All rights reserved.
// Licensed under the Apache License, Version 2.0 (found in
// the LICENSE-APACHE file) or the MIT license (found in
// the LICENSE-MIT file), at your option.

use accesskit_atspi_common::PlatformNode;
use zbus::{fdo, interface};

fn unsupported() -> fdo::Error {
    fdo::Error::NotSupported("editing operation is not supported".into())
}

pub(crate) struct EditableTextInterface(PlatformNode);

impl EditableTextInterface {
    pub fn new(node: PlatformNode) -> Self {
        Self(node)
    }

    fn map_error(&self) -> impl '_ + FnOnce(accesskit_atspi_common::Error) -> fdo::Error {
        |error| crate::util::map_error_from_node(&self.0, error)
    }
}

#[interface(name = "org.a11y.atspi.EditableText")]
impl EditableTextInterface {
    fn set_text_contents(&self, new_contents: &str) -> fdo::Result<bool> {
        self.0
            .set_text_contents(new_contents)
            .map_err(self.map_error())
    }

    // mirin: inserted as a replacement of the empty range at `position`
    // (accesskit_atspi_common's `insert_text`); `length` (bytes, -1 for all)
    // cuts `text` at a character's edge.
    fn insert_text(&self, position: i32, text: &str, length: i32) -> fdo::Result<bool> {
        let text = usize::try_from(length).map_or(text, |length| {
            let mut end = length.min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            &text[..end]
        });
        self.0
            .insert_text(position, text)
            .map_err(self.map_error())
    }

    fn copy_text(&self, _start_pos: i32, _end_pos: i32) -> fdo::Result<()> {
        Err(unsupported())
    }

    fn cut_text(&self, _start_pos: i32, _end_pos: i32) -> fdo::Result<bool> {
        Err(unsupported())
    }

    // mirin: deleted as a replacement of the range by nothing.
    fn delete_text(&self, start_pos: i32, end_pos: i32) -> fdo::Result<bool> {
        self.0
            .delete_text(start_pos, end_pos)
            .map_err(self.map_error())
    }

    fn paste_text(&self, _position: i32) -> fdo::Result<bool> {
        Err(unsupported())
    }
}
