//! Where the keyboard goes next, from the element tree alone: the Tab order
//! (fields and `focusable` views in document order, a `focusGroup` as one
//! stop, only what is inside the shown `focusTrap`), the arrows inside a
//! group, and which `onWindowKey` view hears the keys no control takes.
//! Pure, so the rules are tested without a window.

use std::collections::HashMap;

use crate::tree::{parse_color, NodeSpec};

/// The ring's color when no view on the way up names one.
pub(crate) const DEFAULT_RING: u32 = 0x3b82_f6ff;

/// One place the keyboard can go.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Stop {
    pub id: String,
    /// A text field (it shows focus with its own border, not a ring).
    pub field: bool,
    /// The nearest `focusGroup` around it (fields never join one).
    pub group: Option<String>,
    /// The innermost `focusTrap` around it.
    pub trap: Option<String>,
    /// Said to be selected or checked (`access`): where Tab enters its group.
    pub selected: bool,
    /// The ring's color (`0xRRGGBBAA`).
    pub ring: u32,
}

/// The tree's focus facts, in document order.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Order {
    pub stops: Vec<Stop>,
    /// Groups whose selection follows the arrows (`selectsOnFocus`).
    pub selecting: Vec<String>,
    /// Every `focusTrap` view; the last one holds Tab.
    pub traps: Vec<String>,
    /// Every `onWindowKey` view; the last one hears the keys.
    pub window_keys: Vec<String>,
}

#[derive(Clone, Copy)]
struct Context<'a> {
    group: Option<&'a str>,
    trap: Option<&'a str>,
    ring: u32,
}

impl Order {
    pub(crate) fn of(tree: &NodeSpec) -> Self {
        let mut order = Order::default();
        let context = Context {
            group: None,
            trap: None,
            ring: DEFAULT_RING,
        };
        order.walk(tree, context);
        order
    }

    fn walk<'a>(&mut self, node: &'a NodeSpec, context: Context<'a>) {
        match node {
            NodeSpec::View { props, children } => {
                let mut inner = context;
                if let Some(ring) = props.focus_ring_color.as_deref().and_then(parse_color) {
                    inner.ring = ring;
                }
                if let Some(id) = props.id.as_deref() {
                    if props.focusable {
                        let access = props.access.as_ref();
                        let selected = access.is_some_and(|access| {
                            access.selected == Some(true) || access.checked == Some(true)
                        });
                        self.stops.push(Stop {
                            id: id.to_owned(),
                            field: false,
                            group: context.group.map(str::to_owned),
                            trap: context.trap.map(str::to_owned),
                            selected,
                            ring: inner.ring,
                        });
                    }
                    if props.focus_group {
                        inner.group = Some(id);
                        if props.selects_on_focus {
                            self.selecting.push(id.to_owned());
                        }
                    }
                    if props.focus_trap {
                        inner.trap = Some(id);
                        self.traps.push(id.to_owned());
                    }
                    if props.on_window_key {
                        self.window_keys.push(id.to_owned());
                    }
                }
                for child in children {
                    self.walk(child, inner);
                }
            }
            NodeSpec::Input { props } => self.stops.push(Stop {
                id: props.id.clone(),
                field: true,
                group: None,
                trap: context.trap.map(str::to_owned),
                selected: false,
                ring: context.ring,
            }),
            NodeSpec::Text { .. } | NodeSpec::Svg { .. } | NodeSpec::Image { .. } => {}
        }
    }

    pub(crate) fn stop(&self, id: &str) -> Option<&Stop> {
        self.stops.iter().find(|stop| stop.id == id)
    }

    /// The trap that holds Tab: the last one in document order.
    pub(crate) fn trap(&self) -> Option<&str> {
        self.traps.last().map(String::as_str)
    }

    /// The view that hears the keys no control takes.
    pub(crate) fn window_key(&self) -> Option<&str> {
        self.window_keys.last().map(String::as_str)
    }

    /// Whether `id` may have the keyboard now: inside the trap, if one is shown.
    pub(crate) fn reachable(&self, id: &str) -> bool {
        self.stop(id)
            .is_some_and(|stop| self.trap().is_none() || stop.trap.as_deref() == self.trap())
    }

    pub(crate) fn selects(&self, group: &str) -> bool {
        self.selecting.iter().any(|id| id == group)
    }

    fn reachable_stops(&self) -> impl Iterator<Item = &Stop> {
        let trap = self.trap();
        self.stops
            .iter()
            .filter(move |stop| trap.is_none() || stop.trap.as_deref() == trap)
    }

    /// Where Tab (`back`: Shift+Tab) goes from `from` (none: the window
    /// itself has the keyboard). A group is one stop, entered at the member
    /// that last had the keyboard (`last`), else its selected one, else its
    /// first. Wraps around; None when nothing can take the keyboard.
    pub(crate) fn tab(
        &self,
        from: Option<&str>,
        back: bool,
        last: &HashMap<String, String>,
    ) -> Option<String> {
        // One entry per stop: a field or view, or a whole group (at its first member).
        let mut tabs: Vec<&Stop> = Vec::new();
        for stop in self.reachable_stops() {
            let joined = stop
                .group
                .as_ref()
                .is_some_and(|group| tabs.iter().any(|seen| seen.group.as_ref() == Some(group)));
            if !joined {
                tabs.push(stop);
            }
        }
        if tabs.is_empty() {
            return None;
        }
        let current = from.and_then(|id| self.stop(id)).and_then(|stop| {
            tabs.iter().position(|tab| match (&stop.group, &tab.group) {
                (Some(group), Some(other)) => group == other,
                _ => tab.id == stop.id,
            })
        });
        let len = tabs.len();
        let next = match (current, back) {
            (None, false) => 0,
            (None, true) => len - 1,
            (Some(at), false) => (at + 1) % len,
            (Some(at), true) => (at + len - 1) % len,
        };
        let tab = tabs[next];
        let Some(group) = tab.group.as_deref() else {
            return Some(tab.id.clone());
        };
        let members: Vec<&Stop> = self
            .reachable_stops()
            .filter(|stop| stop.group.as_deref() == Some(group))
            .collect();
        let remembered = last
            .get(group)
            .and_then(|id| members.iter().find(|stop| &stop.id == id));
        let chosen = remembered
            .or_else(|| members.iter().find(|stop| stop.selected))
            .unwrap_or(&tab);
        Some(chosen.id.clone())
    }

    /// The group member an arrow moves to from `from` (`step` -1 or +1),
    /// stopping at the ends; None when `from` is in no group or at an end.
    pub(crate) fn arrow(&self, from: &str, step: isize) -> Option<String> {
        let group = self.stop(from)?.group.as_deref()?;
        let members: Vec<&Stop> = self
            .reachable_stops()
            .filter(|stop| stop.group.as_deref() == Some(group))
            .collect();
        let at = members.iter().position(|stop| stop.id == from)?;
        let next = at.checked_add_signed(step)?;
        members.get(next).map(|stop| stop.id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::parse_tree;

    fn order(json: &str) -> Order {
        Order::of(&parse_tree(json).expect("test tree must parse"))
    }

    fn tab(order: &Order, from: Option<&str>) -> Option<String> {
        order.tab(from, false, &HashMap::new())
    }

    const FORM: &str = r##"{"type":"view","props":{"id":"root","focusRingColor":"#112233"},"children":[
        {"type":"input","props":{"id":"name"}},
        {"type":"view","props":{"id":"seg","focusGroup":true},"children":[
            {"type":"view","props":{"id":"a","focusable":true,"onPress":true}},
            {"type":"view","props":{"id":"b","focusable":true,"onPress":true,"access":{"selected":true}}},
            {"type":"view","props":{"id":"c","focusable":true,"onPress":true}}]},
        {"type":"view","props":{"id":"plain","onPress":true}},
        {"type":"view","props":{"id":"ok","focusable":true,"onPress":true,"focusRingColor":"#445566"}}]}"##;

    #[test]
    fn tab_walks_fields_and_views_in_order_and_wraps() {
        let order = order(FORM);
        // From the window itself: the first stop.
        assert_eq!(tab(&order, None).as_deref(), Some("name"));
        // Into the group at its selected member; a view without focusable is skipped.
        assert_eq!(tab(&order, Some("name")).as_deref(), Some("b"));
        assert_eq!(tab(&order, Some("b")).as_deref(), Some("ok"));
        assert_eq!(tab(&order, Some("ok")).as_deref(), Some("name"));
        // Shift+Tab goes back, and from the window to the last stop.
        let back = |from| order.tab(from, true, &HashMap::new());
        assert_eq!(back(None).as_deref(), Some("ok"));
        assert_eq!(back(Some("ok")).as_deref(), Some("b"));
        assert_eq!(back(Some("a")).as_deref(), Some("name"));
    }

    #[test]
    fn a_group_is_entered_where_the_keyboard_last_was() {
        let order = order(FORM);
        let last = HashMap::from([("seg".to_owned(), "c".to_owned())]);
        assert_eq!(order.tab(Some("name"), false, &last).as_deref(), Some("c"));
        // A member that left the tree is forgotten: the selected one again.
        let gone = HashMap::from([("seg".to_owned(), "z".to_owned())]);
        assert_eq!(order.tab(Some("name"), false, &gone).as_deref(), Some("b"));
    }

    #[test]
    fn arrows_move_inside_a_group_and_stop_at_its_ends() {
        let order = order(FORM);
        assert_eq!(order.arrow("b", 1).as_deref(), Some("c"));
        assert_eq!(order.arrow("b", -1).as_deref(), Some("a"));
        assert_eq!(order.arrow("a", -1), None);
        assert_eq!(order.arrow("c", 1), None);
        // Outside a group the arrows are not the focus model's.
        assert_eq!(order.arrow("ok", 1), None);
        assert_eq!(order.arrow("name", 1), None);
    }

    #[test]
    fn the_ring_takes_the_nearest_color() {
        let order = order(FORM);
        assert_eq!(order.stop("a").map(|stop| stop.ring), Some(0x1122_33ff));
        assert_eq!(order.stop("ok").map(|stop| stop.ring), Some(0x4455_66ff));
        let bare = super::Order::of(
            &parse_tree(r##"{"type":"view","props":{"id":"x","focusable":true}}"##)
                .expect("a bare focusable view must parse"),
        );
        assert_eq!(bare.stop("x").map(|stop| stop.ring), Some(DEFAULT_RING));
    }

    #[test]
    fn a_trap_keeps_tab_inside_it() {
        let order = order(
            r##"{"type":"view","props":{"id":"root"},"children":[
            {"type":"view","props":{"id":"behind","focusable":true}},
            {"type":"view","props":{"id":"sheet","focusTrap":true},"children":[
                {"type":"input","props":{"id":"field"}},
                {"type":"view","props":{"id":"cancel","focusable":true}}]}]}"##,
        );
        assert_eq!(order.trap(), Some("sheet"));
        assert_eq!(tab(&order, None).as_deref(), Some("field"));
        assert_eq!(tab(&order, Some("field")).as_deref(), Some("cancel"));
        assert_eq!(tab(&order, Some("cancel")).as_deref(), Some("field"));
        // What is behind the sheet can't have the keyboard, and Tab from it enters the sheet.
        assert!(!order.reachable("behind"));
        assert!(order.reachable("cancel"));
        assert_eq!(tab(&order, Some("behind")).as_deref(), Some("field"));
    }

    #[test]
    fn nothing_to_reach_is_none() {
        let order = order(r##"{"type":"view","props":{"id":"root","onPress":true}}"##);
        assert_eq!(tab(&order, None), None);
    }

    #[test]
    fn the_last_window_key_view_hears_the_keys() {
        let order = order(
            r##"{"type":"view","props":{"id":"root"},"children":[
            {"type":"view","props":{"id":"keys","onWindowKey":true}},
            {"type":"view","props":{"id":"menu","focusGroup":true,"selectsOnFocus":true},"children":[
                {"type":"view","props":{"id":"menu-keys","onWindowKey":true}}]}]}"##,
        );
        assert_eq!(order.window_key(), Some("menu-keys"));
        assert!(order.selects("menu"));
        assert!(!order.selects("root"));
    }
}
