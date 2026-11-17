//! What a screen reader's or an agent's request on a node becomes: the
//! window's own simulated input (`sim.rs`), so it goes where the person's
//! click, focus or typing would.

use super::tree::Request;
use crate::sim::SimCommand;

/// What a screen reader's or an agent's request does, as the window's
/// simulated input (`sim.rs`): it goes where the person's would.
pub(super) fn command_for(request: Request) -> SimCommand {
    match request {
        Request::Click(id) => SimCommand::Click {
            id: Some(id.to_owned()),
            x: None,
            y: None,
        },
        Request::Focus(id) => SimCommand::Focus { id: id.to_owned() },
        Request::SetText(id, text) => SimCommand::SetText {
            id: id.to_owned(),
            text,
        },
        Request::InsertText(id, text) => SimCommand::InsertText {
            id: id.to_owned(),
            text,
        },
        Request::Select(id, anchor, focus) => SimCommand::SelectChars {
            id: id.to_owned(),
            anchor,
            focus,
        },
    }
}
