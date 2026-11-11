//! A Metal window's accessibility tree as AccessKit nodes, built from the
//! element tree the driver sent and what only the renderer knows (painted
//! bounds, which field has the keyboard, what is typed in it).
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

use accesskit::{Action, Live, Node, NodeId, Rect, Role, Toggled, TreeId, TreeInfo, TreeUpdate};

use crate::tree::{AccessProps, NodeSpec};

/// The window itself.
pub(crate) const ROOT: NodeId = NodeId(0);

/// What the tree needs from the renderer.
pub(crate) struct Facts<'a> {
    /// The window's title: the root's name.
    pub title: &'a str,
    /// A node's painted bounds in window pixels.
    pub bounds: &'a dyn Fn(&str) -> Option<Rect>,
    /// The field (or key-taking view) with the keyboard.
    pub focused: Option<&'a str>,
    /// What is in a field now (the renderer's buffer; the driver's value lags).
    pub text_of: &'a dyn Fn(&str) -> Option<String>,
}

/// A tree to hand the adapter, and which element each pressable node is.
pub(crate) struct Built {
    pub update: TreeUpdate,
    pub targets: Targets,
}

/// Where a screen reader's action on a node goes.
#[derive(Default)]
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

struct Walk<'a, 'f> {
    facts: &'a Facts<'f>,
    nodes: Vec<(NodeId, Node)>,
    targets: Targets,
    /// The focused field's node; where it is in `nodes` when it is a combo box; the selected options seen.
    focus: Option<NodeId>,
    combobox: Option<usize>,
    selected: Vec<NodeId>,
}

impl Walk<'_, '_> {
    fn place(&self, node: &mut Node, id: &str) {
        if let Some(bounds) = (self.facts.bounds)(id) {
            node.set_bounds(bounds);
        }
    }

    /// `spec` and what is under it as nodes; the ones that are its parent's children join `out`.
    fn node(&mut self, spec: &NodeSpec, key: &str, out: &mut Vec<NodeId>) {
        match spec {
            NodeSpec::View { props, children } => self.view(props, children, key, out),
            NodeSpec::Text { children, .. } => {
                let words = children.concat();
                if words.trim().is_empty() {
                    return;
                }
                let id = node_id(key);
                let mut node = Node::new(Role::Label);
                node.set_value(words);
                self.nodes.push((id, node));
                out.push(id);
            }
            NodeSpec::Input { props } => self.input(props, out),
            NodeSpec::Svg { .. } | NodeSpec::Image { .. } => {}
        }
    }

    fn view(
        &mut self,
        props: &crate::tree::ViewProps,
        children: &[NodeSpec],
        key: &str,
        out: &mut Vec<NodeId>,
    ) {
        let access = props.access.as_ref();
        let id = props.id.as_deref().unwrap_or(key);
        let role = access
            .and_then(|access| access.role.as_deref())
            .and_then(role_of)
            .or_else(|| props.on_press.then_some(Role::Button))
            .or_else(|| props.focusable.then_some(Role::Group))
            .or_else(|| {
                access
                    .and_then(|access| access.label.as_ref())
                    .map(|_| Role::Group)
            });
        let Some(role) = role else {
            for (index, child) in children.iter().enumerate() {
                self.node(child, &format!("{id}/{index}"), out);
            }
            return;
        };
        let node_id = node_id(id);
        let mut node = Node::new(role);
        if let Some(access) = access {
            apply_state(&mut node, access);
            if access.selected == Some(true) {
                self.selected.push(node_id);
            }
        }
        self.place(&mut node, id);
        if props.on_press {
            node.add_action(Action::Click);
            self.targets.press.insert(node_id, id.to_owned());
        }
        // A focusable view with the keyboard is the focus (`focus/`).
        if props.focusable {
            node.add_action(Action::Focus);
            self.targets.focus.insert(node_id, id.to_owned());
            if self.facts.focused == Some(id) {
                self.focus = Some(node_id);
            }
        }
        let labelled = access.is_some_and(|access| access.label.is_some());
        if !(labelled && speaks_for_content(role)) {
            let mut inner = Vec::new();
            for (index, child) in children.iter().enumerate() {
                self.node(child, &format!("{id}/{index}"), &mut inner);
            }
            node.set_children(inner);
        }
        self.nodes.push((node_id, node));
        out.push(node_id);
    }

    fn input(&mut self, props: &crate::tree::InputProps, out: &mut Vec<NodeId>) {
        let access = props.access.as_deref();
        let role = match access.and_then(|access| access.role.as_deref()) {
            Some("combobox") => Role::EditableComboBox,
            Some("search" | "searchbox") => Role::SearchInput,
            _ if props.secure => Role::PasswordInput,
            _ if props.multiline => Role::MultilineTextInput,
            _ => Role::TextInput,
        };
        let node_id = node_id(&props.id);
        let mut node = Node::new(role);
        if let Some(access) = access {
            apply_state(&mut node, access);
        }
        if access.and_then(|access| access.label.as_ref()).is_none() {
            if let Some(placeholder) = props.placeholder.as_deref() {
                node.set_label(placeholder);
            }
        }
        // A password field's words are never published.
        if !props.secure {
            let text = (self.facts.text_of)(&props.id).unwrap_or_else(|| props.value.clone());
            node.set_value(text);
        }
        node.add_action(Action::Focus);
        node.add_action(Action::Click);
        self.place(&mut node, &props.id);
        self.targets.press.insert(node_id, props.id.clone());
        self.targets.focus.insert(node_id, props.id.clone());
        if self.facts.focused == Some(props.id.as_str()) {
            self.focus = Some(node_id);
            if role == Role::EditableComboBox {
                self.combobox = Some(self.nodes.len());
            }
        }
        self.nodes.push((node_id, node));
        out.push(node_id);
    }
}

/// The whole tree for `tree`, rooted at the window.
pub(crate) fn build(tree: &NodeSpec, facts: &Facts) -> Built {
    let mut walk = Walk {
        facts,
        nodes: Vec::new(),
        targets: Targets::default(),
        focus: None,
        combobox: None,
        selected: Vec::new(),
    };
    let mut top = Vec::new();
    walk.node(tree, "root", &mut top);
    // The focused combo box points at the selected option.
    if let (Some(at), Some(&option)) = (walk.combobox, walk.selected.first()) {
        if let Some((_, node)) = walk.nodes.get_mut(at) {
            node.set_active_descendant(option);
        }
    }
    let mut root = Node::new(Role::Window);
    root.set_label(facts.title);
    root.set_children(top);
    walk.nodes.push((ROOT, root));
    let mut info = TreeInfo::new(ROOT);
    info.toolkit_name = Some("mirin metal".into());
    Built {
        update: TreeUpdate {
            nodes: walk.nodes,
            tree: Some(info),
            tree_id: TreeId::ROOT,
            focus: walk.focus.unwrap_or(ROOT),
        },
        targets: walk.targets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::parse_tree;

    fn facts(focused: Option<&str>) -> Facts<'_> {
        Facts {
            title: "Launcher",
            bounds: &|_| Some(Rect::new(0.0, 0.0, 10.0, 10.0)),
            focused,
            text_of: &|id| (id == "field").then(|| "wi".to_owned()),
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
