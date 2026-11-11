//! A Metal window's accessibility tree as AccessKit nodes: what each element
//! of the tree the driver sent says of itself. What only the renderer knows
//! (painted bounds, which field has the keyboard, what is typed in it) and
//! which nodes an update carries are `published.rs`'s.
//!
//! - A view is a node when it says what it is (`access`: a role or a label)
//!   or can be pressed (a button by default, named by its text). Other views
//!   are only layout: their children join the nearest node above them.
//! - Text is a label node with its words as its value, unless a node above
//!   it has a label of its own that stands for it (an option, a button).
//! - A field is a text input (a password input when it hides what is typed),
//!   or an editable combo box when its role says `combobox`.
//! - The field with the keyboard is the focus. A combo box that has it points
//!   at the selected option as its active descendant, so a screen reader
//!   announces the selection as it moves while typing stays in the field.
//!
//! Ids are stable across trees: a hash of the node's own id (every view and
//! field has one), or of its parent's and its place for text, so a screen
//! reader keeps its place when a new tree arrives.

use std::collections::HashMap;

use accesskit::{Action, Live, Node, NodeId, Rect, Role, Toggled};

use crate::tree::{AccessProps, InputProps, ViewProps};

/// The window itself.
pub(crate) const ROOT: NodeId = NodeId(0);

/// What the tree needs from the renderer.
pub(crate) struct Facts<'a> {
    /// The window's title: the root's name.
    pub title: &'a str,
    /// A node's painted bounds in window pixels.
    pub bounds: &'a dyn Fn(&str) -> Option<Rect>,
    /// Whether any bounds may differ from the last update's (the layout's
    /// revision moved): every kept node's are compared then.
    pub moved: bool,
    /// The field (or key-taking view) with the keyboard.
    pub focused: Option<&'a str>,
    /// What is in it now, when it is a field (the renderer's buffer; the
    /// driver's value lags).
    pub typed: Option<&'a str>,
}

/// Where a screen reader's action on a node goes.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Targets {
    /// Node → the element id a click goes to (pressable views and fields).
    press: HashMap<NodeId, String>,
    /// Node → the element id that takes the keyboard (focusable views and fields).
    focus: HashMap<NodeId, String>,
}

/// What a screen reader's action does to an element.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Request<'a> {
    /// Click it, as the person's click would.
    Click(&'a str),
    /// Give it the keyboard, pressing nothing.
    Focus(&'a str),
}

impl Targets {
    /// What `action` on `node` does: a click clicks a pressable node, a focus
    /// moves the keyboard to a field or focusable view. Focusing a button
    /// never presses it.
    pub(crate) fn request(&self, action: Action, node: NodeId) -> Option<Request<'_>> {
        match action {
            Action::Click => self.press.get(&node).map(|id| Request::Click(id)),
            Action::Focus => self.focus.get(&node).map(|id| Request::Focus(id)),
            _ => None,
        }
    }

    /// `node` is `element` now, or no element's (text, the window): what it
    /// takes is what the node says it does.
    pub(crate) fn set(&mut self, id: NodeId, node: &Node, element: Option<&str>) {
        let actions = [
            (&mut self.press, Action::Click),
            (&mut self.focus, Action::Focus),
        ];
        for (targets, action) in actions {
            match element.filter(|_| node.supports_action(action)) {
                Some(element) if targets.get(&id).is_some_and(|kept| kept == element) => {}
                Some(element) => {
                    targets.insert(id, element.to_owned());
                }
                None => {
                    targets.remove(&id);
                }
            }
        }
    }

    /// `node` left the tree.
    pub(crate) fn forget(&mut self, node: NodeId) {
        self.press.remove(&node);
        self.focus.remove(&node);
    }
}

/// A stable node id for `key` (FNV-1a), never the root's.
pub(crate) fn node_id(key: &str) -> NodeId {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    NodeId(hash.max(1))
}

/// A role's name, as the driver says it (React Native's and ARIA's words).
pub(crate) fn role_of(name: &str) -> Option<Role> {
    Some(match name {
        "button" => Role::Button,
        "link" => Role::Link,
        "combobox" => Role::ComboBox,
        "listbox" => Role::ListBox,
        "option" => Role::ListBoxOption,
        "list" => Role::List,
        "listitem" => Role::ListItem,
        "group" => Role::Group,
        "status" => Role::Status,
        "alert" => Role::Alert,
        "heading" | "header" => Role::Heading,
        "switch" => Role::Switch,
        "checkbox" => Role::CheckBox,
        "image" => Role::Image,
        "text" => Role::Label,
        "menu" => Role::Menu,
        "menuitem" => Role::MenuItem,
        "tab" => Role::Tab,
        "tablist" => Role::TabList,
        "dialog" => Role::Dialog,
        "search" | "searchbox" => Role::SearchInput,
        _ => return None,
    })
}

/// Roles whose label stands for everything inside them: their text isn't read twice.
fn speaks_for_content(role: Role) -> bool {
    matches!(
        role,
        Role::Button
            | Role::Link
            | Role::ListBoxOption
            | Role::ListItem
            | Role::Status
            | Role::Alert
            | Role::Heading
            | Role::Switch
            | Role::CheckBox
            | Role::Image
            | Role::Label
            | Role::MenuItem
            | Role::Tab
    )
}

fn apply_state(node: &mut Node, access: &AccessProps) {
    if let Some(label) = access.label.as_deref().filter(|label| !label.is_empty()) {
        node.set_label(label);
    }
    if let Some(selected) = access.selected {
        node.set_selected(selected);
    }
    if let Some(checked) = access.checked {
        node.set_toggled(Toggled::from(checked));
    }
    if let Some(expanded) = access.expanded {
        node.set_expanded(expanded);
    }
    if access.disabled == Some(true) {
        node.set_disabled();
    }
    match access.live.as_deref() {
        Some("polite") => node.set_live(Live::Polite),
        Some("assertive") => node.set_live(Live::Assertive),
        _ => {}
    }
}

/// What a view is, if it is a node at all: the role it says, else a button
/// when it can be pressed, else a group when it takes the keyboard or has a
/// label. None for a view that is only layout.
pub(crate) fn view_role(props: &ViewProps) -> Option<Role> {
    let access = props.access.as_ref();
    access
        .and_then(|access| access.role.as_deref())
        .and_then(role_of)
        .or_else(|| props.on_press.then_some(Role::Button))
        .or_else(|| props.focusable.then_some(Role::Group))
        .or_else(|| {
            access
                .and_then(|access| access.label.as_ref())
                .map(|_| Role::Group)
        })
}

/// A view's node, before its children and its bounds.
pub(crate) fn view_node(props: &ViewProps, role: Role) -> Node {
    let mut node = Node::new(role);
    if let Some(access) = props.access.as_ref() {
        apply_state(&mut node, access);
    }
    if props.on_press {
        node.add_action(Action::Click);
    }
    // A focusable view with the keyboard is the focus (`focus/`).
    if props.focusable {
        node.add_action(Action::Focus);
    }
    node
}

/// Whether the view's label stands for what is inside it (nothing under it
/// is a node then).
pub(crate) fn stands_for_content(props: &ViewProps, role: Role) -> bool {
    let labelled = props
        .access
        .as_ref()
        .is_some_and(|access| access.label.is_some());
    labelled && speaks_for_content(role)
}

/// Whether the view says it is selected (a combo box points at the first).
pub(crate) fn is_selected(props: &ViewProps) -> bool {
    props
        .access
        .as_ref()
        .is_some_and(|access| access.selected == Some(true))
}

/// A text's node: a label whose value is its words.
pub(crate) fn text_node(words: String) -> Node {
    let mut node = Node::new(Role::Label);
    node.set_value(words);
    node
}

/// A field's node with the driver's value, before its bounds. A password
/// field's words are never published.
pub(crate) fn field_node(props: &InputProps) -> Node {
    let access = props.access.as_deref();
    let role = match access.and_then(|access| access.role.as_deref()) {
        Some("combobox") => Role::EditableComboBox,
        Some("search" | "searchbox") => Role::SearchInput,
        _ if props.secure => Role::PasswordInput,
        _ if props.multiline => Role::MultilineTextInput,
        _ => Role::TextInput,
    };
    let mut node = Node::new(role);
    if let Some(access) = access {
        apply_state(&mut node, access);
    }
    if access.and_then(|access| access.label.as_ref()).is_none() {
        if let Some(placeholder) = props.placeholder.as_deref() {
            node.set_label(placeholder);
        }
    }
    if !props.secure {
        node.set_value(props.value.clone());
    }
    node.add_action(Action::Focus);
    node.add_action(Action::Click);
    node
}

/// The window's node: named by its title, over the tree's top nodes.
pub(crate) fn window_node(title: &str, children: Vec<NodeId>) -> Node {
    let mut node = Node::new(Role::Window);
    node.set_label(title);
    node.set_children(children);
    node
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use accesskit::TreeUpdate;

    use super::super::published::Published;
    use super::*;
    use crate::patch::Document;
    use crate::tree::{parse_tree, NodeSpec};

    fn facts(focused: Option<&str>) -> Facts<'_> {
        Facts {
            title: "Launcher",
            bounds: &|_| Some(Rect::new(0.0, 0.0, 10.0, 10.0)),
            moved: true,
            focused,
            typed: (focused == Some("field")).then_some("wi"),
        }
    }

    /// A first, whole tree, and which element each pressable node is.
    struct Built {
        update: TreeUpdate,
        targets: Targets,
    }

    fn build(tree: &NodeSpec, facts: &Facts) -> Built {
        let targets = Mutex::default();
        let update = Published::default().update(&Document::new(tree.clone()), facts, &targets);
        Built {
            update: update.tree,
            targets: targets
                .into_inner()
                .expect("nothing else holds the targets"),
        }
    }

    fn find(built: &Built, id: NodeId) -> &Node {
        &built
            .update
            .nodes
            .iter()
            .find(|(each, _)| *each == id)
            .expect("the node is in the tree")
            .1
    }

    const LAUNCHER: &str = r##"{"type":"view","props":{"id":"1"},"children":[
        {"type":"input","props":{"id":"field","value":"w","placeholder":"An app","access":{"role":"combobox","label":"Search","expanded":true}}},
        {"type":"view","props":{"id":"list","access":{"role":"listbox","label":"Results"}},"children":[
            {"type":"view","props":{"id":"r1","onPress":true,"access":{"role":"option","label":"Wi-Fi, on, setting, 1 of 2","selected":true}},
             "children":[{"type":"text","children":["Wi-Fi"]}]},
            {"type":"view","props":{"id":"r2","onPress":true,"access":{"role":"option","label":"Network, setting, 2 of 2","selected":false}},
             "children":[{"type":"text","children":["Network"]}]}
        ]},
        {"type":"view","props":{"id":"note","access":{"role":"status","label":"Copied","live":"polite"}}}
    ]}"##;

    #[test]
    fn the_launcher_is_a_combobox_over_a_listbox_of_options() {
        let tree = parse_tree(LAUNCHER).unwrap();
        let built = build(&tree, &facts(Some("field")));
        let field = find(&built, node_id("field"));
        assert_eq!(field.role(), Role::EditableComboBox);
        assert_eq!(field.label(), Some("Search"));
        assert_eq!(
            field.value(),
            Some("wi"),
            "the typed words, not the driver's lagging value"
        );
        // Focus stays in the field; the selection is its active descendant.
        assert_eq!(built.update.focus, node_id("field"));
        assert_eq!(field.active_descendant(), Some(node_id("r1")));
        let list = find(&built, node_id("list"));
        assert_eq!(list.role(), Role::ListBox);
        assert_eq!(list.children(), &[node_id("r1"), node_id("r2")]);
        let first = find(&built, node_id("r1"));
        assert_eq!(first.role(), Role::ListBoxOption);
        assert_eq!(first.label(), Some("Wi-Fi, on, setting, 1 of 2"));
        assert_eq!(first.is_selected(), Some(true));
        assert!(first.children().is_empty(), "its label stands for its text");
        assert_eq!(
            built.targets.request(Action::Click, node_id("r2")),
            Some(Request::Click("r2"))
        );
        assert_eq!(
            built.targets.request(Action::Focus, node_id("field")),
            Some(Request::Focus("field"))
        );
        assert_eq!(find(&built, node_id("note")).live(), Some(Live::Polite));
        let root = find(&built, ROOT);
        assert_eq!(root.label(), Some("Launcher"));
        assert_eq!(
            root.children().len(),
            3,
            "the unnamed root view is only layout"
        );
    }

    #[test]
    fn without_access_props_a_press_is_a_button_named_by_its_text() {
        let tree = parse_tree(
            r#"{"type":"view","props":{"id":"1"},"children":[
                {"type":"view","props":{"id":"ok","onPress":true},"children":[{"type":"text","children":["OK"]}]},
                {"type":"text","children":["Plain words"]},
                {"type":"input","props":{"id":"pw","value":"hunter2","secure":true,"placeholder":"Password"}}
            ]}"#,
        )
        .unwrap();
        let built = build(&tree, &facts(None));
        let ok = find(&built, node_id("ok"));
        assert_eq!(ok.role(), Role::Button);
        assert_eq!(ok.children().len(), 1);
        let password = find(&built, node_id("pw"));
        assert_eq!(password.role(), Role::PasswordInput);
        assert_eq!(password.value(), None, "a password is never published");
        assert_eq!(password.label(), Some("Password"));
        assert_eq!(built.update.focus, ROOT);
        assert_eq!(find(&built, ROOT).children().len(), 3);
    }

    #[test]
    fn a_focusable_view_with_the_keyboard_is_the_focus() {
        let tree = parse_tree(
            r#"{"type":"view","props":{"id":"1"},"children":[
                {"type":"view","props":{"id":"save","onPress":true,"focusable":true},"children":[{"type":"text","children":["Save"]}]},
                {"type":"view","props":{"id":"group","focusable":true}}
            ]}"#,
        )
        .unwrap();
        let built = build(&tree, &facts(Some("save")));
        assert_eq!(built.update.focus, node_id("save"));
        let save = find(&built, node_id("save"));
        assert_eq!(save.role(), Role::Button);
        assert!(save.supports_action(Action::Focus));
        assert_eq!(
            built.targets.request(Action::Focus, node_id("save")),
            Some(Request::Focus("save")),
            "focusing a button gives it the keyboard and never presses it"
        );
        assert_eq!(
            built.targets.request(Action::Click, node_id("save")),
            Some(Request::Click("save"))
        );
        assert_eq!(
            built.targets.request(Action::Focus, node_id("group")),
            Some(Request::Focus("group"))
        );
        // Focusable but not pressable: still a node, so the focus has one.
        assert_eq!(find(&built, node_id("group")).role(), Role::Group);
    }

    #[test]
    fn ids_are_stable_and_never_the_root() {
        assert_eq!(node_id("r1"), node_id("r1"));
        assert_ne!(node_id("r1"), node_id("r2"));
        assert_ne!(node_id(""), ROOT);
        assert_eq!(role_of("option"), Some(Role::ListBoxOption));
        assert_eq!(role_of("spaceship"), None);
    }
}
