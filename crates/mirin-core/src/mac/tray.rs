//! Menu-bar tray items (NSStatusItem). A tray can show a menu (clicks route
//! through the shared menu target as `menu.click`) and/or emit `tray.click`
//! when it has no menu.

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol},
    sel, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSStatusBar, NSStatusItem};
use objc2_foundation::NSString;
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;

use crate::mac::menu::{build_menu, MenuItemSpec};

const NS_VARIABLE_STATUS_ITEM_LENGTH: f64 = -1.0;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraySpec {
    id: u32,
    title: Option<String>,
    tooltip: Option<String>,
    menu: Option<Vec<MenuItemSpec>>,
}

define_class!(
    /// Target for tray-button clicks (no-menu trays); tag carries the tray id.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    pub struct TrayTarget;

    unsafe impl NSObjectProtocol for TrayTarget {}

    impl TrayTarget {
        #[unsafe(method(trayClicked:))]
        unsafe fn tray_clicked(&self, sender: &objc2::runtime::AnyObject) {
            let tag: isize = msg_send![sender, tag];
            crate::engine::emit_event(&format!(r#"{{"type":"tray.click","id":{tag}}}"#));
        }
    }
);

impl TrayTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = TrayTarget::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    static TRAYS: RefCell<HashMap<u32, Retained<NSStatusItem>>> = RefCell::new(HashMap::new());
    static TARGET: RefCell<Option<Retained<TrayTarget>>> = const { RefCell::new(None) };
}

fn shared_target(mtm: MainThreadMarker) -> Retained<TrayTarget> {
    TARGET.with(|t| {
        t.borrow_mut()
            .get_or_insert_with(|| TrayTarget::new(mtm))
            .clone()
    })
}

/// Create or replace a tray item from JSON. Main thread only.
pub fn create(json: &str) {
    let Ok(spec) = serde_json::from_str::<TraySpec>(json) else {
        return;
    };
    let mtm = MainThreadMarker::new().expect("tray on main thread");

    let bar = NSStatusBar::systemStatusBar();
    let item = bar.statusItemWithLength(NS_VARIABLE_STATUS_ITEM_LENGTH);

    if let Some(button) = item.button(mtm) {
        if let Some(title) = &spec.title {
            button.setTitle(&NSString::from_str(title));
        }
        if let Some(tooltip) = &spec.tooltip {
            button.setToolTip(Some(&NSString::from_str(tooltip)));
        }
        if spec.menu.is_none() {
            button.setTag(spec.id as isize);
            let target = shared_target(mtm);
            unsafe {
                button.setTarget(Some(&target));
                button.setAction(Some(sel!(trayClicked:)));
            }
        }
    }

    if let Some(menu_specs) = &spec.menu {
        let menu = build_menu(mtm, menu_specs, "");
        item.setMenu(Some(&menu));
    }

    // Replace any existing tray with this id; keep the new one alive.
    destroy(spec.id);
    TRAYS.with(|t| t.borrow_mut().insert(spec.id, item));
}

/// Remove a tray item by id. Main thread only.
pub fn destroy(id: u32) {
    let item = TRAYS.with(|t| t.borrow_mut().remove(&id));
    if let Some(item) = item {
        let bar = NSStatusBar::systemStatusBar();
        bar.removeStatusItem(&item);
    }
}
