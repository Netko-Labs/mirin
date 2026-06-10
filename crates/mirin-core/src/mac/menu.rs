//! Native menus: the default app menu, custom application menus built from a
//! JSON template, and context-menu popups. Custom items carry a numeric id;
//! clicking one emits a `menu.click` event the Worker routes to its handler.
//! Standard `role` items use AppKit's responder-chain selectors directly.

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol},
    sel, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApp, NSControlStateValueOn, NSEvent, NSEventModifierFlags, NSMenu, NSMenuItem,
};
use objc2_foundation::{NSPoint, NSString};
use serde::Deserialize;
use std::cell::Cell;

/// One menu item from the TS template. Pure data; functions live in the Worker.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct MenuItemSpec {
    /// Routing id for a custom item's click handler.
    pub id: Option<u32>,
    pub label: Option<String>,
    /// "separator" | "submenu" | "normal" (inferred when omitted).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// Standard action, e.g. "quit", "copy", "paste", "selectAll", "minimize".
    pub role: Option<String>,
    /// e.g. "Cmd+N", "Cmd+Shift+P".
    pub accelerator: Option<String>,
    pub enabled: Option<bool>,
    pub checked: Option<bool>,
    pub submenu: Option<Vec<MenuItemSpec>>,
}

define_class!(
    /// Shared target for custom menu items; the item's tag carries its id.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    pub struct MenuTarget;

    unsafe impl NSObjectProtocol for MenuTarget {}

    impl MenuTarget {
        #[unsafe(method(menuItemClicked:))]
        unsafe fn menu_item_clicked(&self, sender: &NSMenuItem) {
            let id = sender.tag();
            crate::engine::emit_event(&format!(r#"{{"type":"menu.click","id":{id}}}"#));
        }
    }
);

impl MenuTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = MenuTarget::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    static TARGET: Cell<Option<Retained<MenuTarget>>> = const { Cell::new(None) };
}

fn shared_target(mtm: MainThreadMarker) -> Retained<MenuTarget> {
    TARGET.with(|t| {
        let existing = t.take();
        let target = existing.unwrap_or_else(|| MenuTarget::new(mtm));
        t.set(Some(target.clone()));
        target
    })
}

/// (default title, selector, default key equivalent) for a standard role.
fn role_action(role: &str) -> Option<(&'static str, objc2::runtime::Sel, &'static str)> {
    let r = match role {
        "quit" => ("Quit", sel!(terminate:), "q"),
        "close" => ("Close", sel!(performClose:), "w"),
        "minimize" => ("Minimize", sel!(performMiniaturize:), "m"),
        "zoom" => ("Zoom", sel!(performZoom:), ""),
        "front" => ("Bring All to Front", sel!(arrangeInFront:), ""),
        "togglefullscreen" => ("Toggle Full Screen", sel!(toggleFullScreen:), ""),
        "hide" => ("Hide", sel!(hide:), "h"),
        "hideothers" => ("Hide Others", sel!(hideOtherApplications:), ""),
        "unhide" => ("Show All", sel!(unhideAllApplications:), ""),
        "undo" => ("Undo", sel!(undo:), "z"),
        "redo" => ("Redo", sel!(redo:), "Z"),
        "cut" => ("Cut", sel!(cut:), "x"),
        "copy" => ("Copy", sel!(copy:), "c"),
        "paste" => ("Paste", sel!(paste:), "v"),
        "selectall" => ("Select All", sel!(selectAll:), "a"),
        "delete" => ("Delete", sel!(delete:), ""),
        _ => return None,
    };
    Some(r)
}

/// Parse "Cmd+Shift+N" into (key equivalent, modifier mask).
fn parse_accelerator(accel: &str) -> (String, NSEventModifierFlags) {
    let mut mask = NSEventModifierFlags::empty();
    let mut key = String::new();
    for part in accel.split('+') {
        match part.trim().to_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" => mask |= NSEventModifierFlags::Command,
            "shift" => mask |= NSEventModifierFlags::Shift,
            "alt" | "option" => mask |= NSEventModifierFlags::Option,
            "ctrl" | "control" => mask |= NSEventModifierFlags::Control,
            other => key = other.to_string(),
        }
    }
    (key, mask)
}

fn build_item(mtm: MainThreadMarker, spec: &MenuItemSpec) -> Retained<NSMenuItem> {
    if spec.kind.as_deref() == Some("separator") {
        return NSMenuItem::separatorItem(mtm);
    }

    // Resolve title/action/key from an explicit role, falling back to the label.
    let (title, action, default_key) = match spec.role.as_deref().and_then(role_action) {
        Some((t, sel, key)) => (
            spec.label.clone().unwrap_or_else(|| t.to_string()),
            Some(sel),
            key.to_string(),
        ),
        None => (spec.label.clone().unwrap_or_default(), None, String::new()),
    };

    let (key_equiv, mask) = match &spec.accelerator {
        Some(a) => parse_accelerator(a),
        None if !default_key.is_empty() => {
            // Roles like Redo carry a shift via an uppercase default key.
            if default_key.chars().next().is_some_and(|c| c.is_uppercase()) {
                (
                    default_key.to_lowercase(),
                    NSEventModifierFlags::Command | NSEventModifierFlags::Shift,
                )
            } else {
                (default_key.clone(), NSEventModifierFlags::Command)
            }
        }
        None => (String::new(), NSEventModifierFlags::empty()),
    };

    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(&title),
            action,
            &NSString::from_str(&key_equiv),
        )
    };
    if !key_equiv.is_empty() {
        item.setKeyEquivalentModifierMask(mask);
    }

    // Custom (no role) items route their clicks to the shared target by tag.
    if spec.role.is_none() && spec.kind.as_deref() != Some("separator") {
        if let Some(id) = spec.id {
            item.setTag(id as isize);
            unsafe { item.setAction(Some(sel!(menuItemClicked:))) };
            let target = shared_target(mtm);
            unsafe { item.setTarget(Some(&target)) };
        }
    }

    if let Some(false) = spec.enabled {
        item.setEnabled(false);
    }
    if spec.checked == Some(true) {
        item.setState(NSControlStateValueOn);
    }

    if let Some(children) = &spec.submenu {
        let submenu = build_menu(mtm, children, spec.label.as_deref().unwrap_or(""));
        item.setSubmenu(Some(&submenu));
    }

    item
}

pub(crate) fn build_menu(
    mtm: MainThreadMarker,
    specs: &[MenuItemSpec],
    title: &str,
) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);
    menu.setTitle(&NSString::from_str(title));
    for spec in specs {
        menu.addItem(&build_item(mtm, spec));
    }
    menu
}

/// Install a minimal default menu so Cmd+Q / Edit shortcuts work before the app
/// sets its own.
pub fn install_default_menu(mtm: MainThreadMarker) {
    let default = [
        MenuItemSpec {
            label: Some("App".into()),
            submenu: Some(vec![MenuItemSpec {
                role: Some("quit".into()),
                ..Default::default()
            }]),
            ..Default::default()
        },
        MenuItemSpec {
            label: Some("Edit".into()),
            submenu: Some(vec![
                MenuItemSpec {
                    role: Some("undo".into()),
                    ..Default::default()
                },
                MenuItemSpec {
                    role: Some("redo".into()),
                    ..Default::default()
                },
                MenuItemSpec {
                    kind: Some("separator".into()),
                    ..Default::default()
                },
                MenuItemSpec {
                    role: Some("cut".into()),
                    ..Default::default()
                },
                MenuItemSpec {
                    role: Some("copy".into()),
                    ..Default::default()
                },
                MenuItemSpec {
                    role: Some("paste".into()),
                    ..Default::default()
                },
                MenuItemSpec {
                    role: Some("selectall".into()),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        },
    ];
    set_app_menu(mtm, &default);
}

/// Replace the application menu bar from a parsed template.
pub fn set_app_menu(mtm: MainThreadMarker, specs: &[MenuItemSpec]) {
    let menubar = NSMenu::new(mtm);
    for spec in specs {
        // Each top-level entry is a submenu hung off a bar item.
        let bar_item = NSMenuItem::new(mtm);
        let title = spec.label.clone().unwrap_or_default();
        let submenu = match &spec.submenu {
            Some(children) => build_menu(mtm, children, &title),
            None => build_menu(mtm, std::slice::from_ref(spec), &title),
        };
        bar_item.setSubmenu(Some(&submenu));
        menubar.addItem(&bar_item);
    }
    NSApp(mtm).setMainMenu(Some(&menubar));
}

/// Pop up a context menu at the current mouse location.
pub fn popup_menu(mtm: MainThreadMarker, specs: &[MenuItemSpec]) {
    let menu = build_menu(mtm, specs, "");
    let location = NSEvent::mouseLocation();
    unsafe {
        let _: bool = msg_send![
            &*menu,
            popUpMenuPositioningItem: std::ptr::null::<NSMenuItem>(),
            atLocation: NSPoint { x: location.x, y: location.y },
            inView: std::ptr::null::<objc2_app_kit::NSView>(),
        ];
    }
}
