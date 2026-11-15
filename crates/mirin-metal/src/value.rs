//! A field's text between its two writers: the person, typing in the
//! renderer, and the app, setting `value` in the tree.
//!
//! The field reports every edit (`change`) with the hash of the text it was
//! made on (`baseHash`) and of the text it made (`textHash`), and a driver
//! that follows them says with each `value` which text its app set it over
//! (`baseHash` on the node): the field's own text coming back is left
//! alone, and an app's write that crossed with typing has the typing
//! carried onto it (`field/rebase.rs`), reported as a `change` made on the
//! app's value. The driver drops a `change` made on a text its app has
//! since replaced, so the two end with the same text and no key is lost.
//! A driver from before `baseHash` is answered as before: a value the
//! field sent itself is a late echo, any other resets the buffer.

use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use sumi::App;

use crate::events::{text_hash, EventSender};
use crate::field::Field;
use crate::ime::CaretReported;
use crate::selection::SelectionState;
use crate::tree::InputProps;
use crate::window::{InputState, RootView};

/// In the host binary while it takes a field's `baseHash` and carries what
/// was typed onto a value written meanwhile; its `protocol` line says
/// `"rebase":true`.
pub const REBASE_MARKER: &str = "MIRIN_METAL_REBASE";

/// Unechoed `change` values kept per input (see `InputState::echoes`).
const MAX_ECHOES: usize = 64;

/// Whether a new driver `value` resets the buffer. A value the renderer sent
/// itself (a late echo, possibly skipping older ones) does not; anything else
/// does, and forgets the pending echoes.
pub(crate) fn driver_resets<T, V>(echoes: &mut VecDeque<T>, value: &V) -> bool
where
    T: PartialEq<V>,
    V: ?Sized,
{
    match echoes.iter().position(|sent| sent == value) {
        Some(echoed) => {
            echoes.drain(..=echoed);
            false
        }
        None => {
            echoes.clear();
            true
        }
    }
}

/// What a driver's new `value` did to a field's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Taken {
    /// Nothing: it is the field's own text, coming back.
    Kept,
    /// It replaced the text.
    Reset,
    /// It replaced the text the driver knew, and what the field had typed
    /// into that text since was done again to it.
    Rebased,
}

/// Take the driver's new `value`, written over the text hashing to
/// `base_hash` (`None`: a driver that doesn't say): `synced` is the value
/// before it, `echoes` the texts reported since and not seen back.
fn take_value(
    field: &mut Field,
    synced: &str,
    echoes: &mut VecDeque<String>,
    value: &str,
    base_hash: Option<u32>,
    reports: bool,
) -> Taken {
    let Some(base_hash) = base_hash else {
        if driver_resets(echoes, value) {
            field.reset(value);
            return Taken::Reset;
        }
        return Taken::Kept;
    };
    if base_hash == text_hash(value) {
        // The driver's app set the text the field reported: the texts
        // before it are no longer waited for.
        if let Some(echoed) = echoes.iter().position(|sent| sent == value) {
            echoes.drain(..=echoed);
        }
        return Taken::Kept;
    }
    // The text the driver knew: its last value, or one reported since.
    let known = std::iter::once(synced)
        .chain(echoes.iter().map(String::as_str))
        .rev()
        .find(|text| text_hash(text) == base_hash);
    let taken = match known {
        Some(known) if reports && known != field.buffer => {
            field.rebase(known, value);
            Taken::Rebased
        }
        // Nothing typed since, a text the field no longer keeps, or a field
        // whose edits the driver never hears: the app's value is the text.
        _ => {
            field.reset(value);
            Taken::Reset
        }
    };
    echoes.clear();
    taken
}

/// Tell the driver the field's text changed (`change`), and expect it back.
fn report_change(state: &mut InputState, id: &str, events: &EventSender) {
    let base_hash = state.text_hash.take();
    state.text_hash = Some(events.change(id, &state.field.buffer, base_hash));
    // Expect it back; a driver that never echoes (or transforms the
    // text) only ever keeps a few.
    if state.echoes.len() >= MAX_ECHOES {
        state.echoes.pop_front();
    }
    state.echoes.push_back(state.field.buffer.clone());
}

impl RootView {
    /// Tell the driver a field's text changed (`change`), and expect it back.
    pub(crate) fn report_change(&mut self, id: &str) {
        if let Some(state) = self.inputs.get_mut(id) {
            report_change(state, id, &self.events);
        }
    }
}

/// Create the editing state of a field new to the tree, or bring an existing
/// one in line with its props: a new `revision` resets the buffer, a new
/// `value` is taken as `take_value` says, a new `selection` selects.
pub(crate) fn sync_input(
    inputs: &mut HashMap<String, InputState>,
    events: &EventSender,
    spec: &InputProps,
    cx: &mut App,
) {
    match inputs.get_mut(&spec.id) {
        Some(state) => {
            let mut taken = Taken::Kept;
            if state.revision != spec.revision {
                state.revision = spec.revision;
                state.field.reset(&spec.value);
                state.synced_value = spec.value.clone();
                state.echoes.clear();
                taken = Taken::Reset;
            } else if state.synced_value != spec.value {
                taken = take_value(
                    &mut state.field,
                    &state.synced_value,
                    &mut state.echoes,
                    &spec.value,
                    spec.base_hash,
                    spec.on_change,
                );
                state.synced_value = spec.value.clone();
            }
            if taken != Taken::Kept {
                // What the field holds was made on the driver's value.
                state.text_hash = None;
            }
            if !spec.on_change {
                state.text_hash = None;
            } else if state.text_hash.is_none() {
                state.text_hash = Some(text_hash(if taken == Taken::Kept {
                    &state.field.buffer
                } else {
                    &spec.value
                }));
            }
            if taken == Taken::Rebased {
                report_change(state, &spec.id, events);
            }
            let field = &mut state.field;
            state.selection.sync(field, spec, taken, events);
            if taken == Taken::Rebased {
                state.selection.report(&spec.id, &state.field, events);
            }
        }
        None => {
            let mut field = Field::new(&spec.value);
            let selection = SelectionState::new(&mut field, spec);
            inputs.insert(
                spec.id.clone(),
                InputState {
                    focus: cx.focus_handle(),
                    field,
                    synced_value: spec.value.clone(),
                    echoes: VecDeque::new(),
                    revision: spec.revision,
                    text_hash: spec.on_change.then(|| text_hash(&spec.value)),
                    wants_focus: spec.autofocus,
                    caret_reported: CaretReported::default(),
                    selection,
                    scroll: Rc::default(),
                },
            );
        }
    }
}

#[cfg(test)]
mod tests;
