//! Nodes a screen reader can press or focus but has no name for
//! (`MIRIN_METAL_ACCESS_CHECK=1` reports them on stderr): a pressable icon
//! with no `accessibilityLabel`, a field with neither a label nor a
//! placeholder. Orca says "button" and nothing else; an agent reading the
//! tree cannot tell one from another.

use std::collections::HashMap;

use accesskit::{Action, NodeId, Role};

use super::published::Kept;

/// The elements whose nodes take a press or the keyboard and have no name:
/// no label of their own and no words under them.
pub(super) fn nameless(kept: &HashMap<NodeId, Kept>) -> Vec<String> {
    let mut found: Vec<String> = kept
        .values()
        .filter(|node| {
            let base = &node.base;
            base.supports_action(Action::Click) || base.supports_action(Action::Focus)
        })
        .filter(|node| !has_words(kept, &node.base, 0))
        .filter_map(|node| node.element.as_deref().map(str::to_owned))
        .collect();
    found.sort_unstable();
    found
}

/// Whether `node` is named: a label, or words in a text under it (a
/// field's are its value, which never names it).
fn has_words(kept: &HashMap<NodeId, Kept>, node: &accesskit::Node, depth: usize) -> bool {
    let words = |text: Option<&str>| text.is_some_and(|text| !text.trim().is_empty());
    if words(node.label()) || (node.role() == Role::Label && words(node.value())) {
        return true;
    }
    if node.role() == Role::Window || depth > 64 {
        return false;
    }
    let fields = [
        Role::TextInput,
        Role::MultilineTextInput,
        Role::PasswordInput,
        Role::SearchInput,
        Role::EditableComboBox,
    ];
    !fields.contains(&node.role())
        && node.children().iter().any(|child| {
            kept.get(child)
                .is_some_and(|child| has_words(kept, &child.base, depth + 1))
        })
}
