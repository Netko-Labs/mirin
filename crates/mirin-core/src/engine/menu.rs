//! Menu commands: parse a JSON template on the UI thread and hand it to the
//! AppKit menu builder. Clicks on custom items come back as `menu.click` events.

use cef::*;
use std::cell::RefCell;

#[derive(Clone, Copy)]
enum MenuKind {
    App,
    Popup,
}

/// Replace the application menu bar from a JSON template (array of items).
pub fn set_app_menu(template_json: String) {
    post(MenuKind::App, template_json);
}

/// Pop up a context menu at the cursor from a JSON template.
pub fn popup_menu(template_json: String) {
    post(MenuKind::Popup, template_json);
}

fn post(kind: MenuKind, json: String) {
    let mut task = MenuTask::new(kind, RefCell::new(Some(json)));
    post_task(ThreadId::UI, Some(&mut task));
}

wrap_task! {
    struct MenuTask {
        kind: MenuKind,
        json: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            let Some(json) = self.json.borrow_mut().take() else { return };
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let _ = json;
            #[cfg(target_os = "macos")]
            {
                use crate::mac::menu::MenuItemSpec;
                let Ok(specs) = serde_json::from_str::<Vec<MenuItemSpec>>(&json) else { return };
                let mtm = objc2::MainThreadMarker::new().expect("menu on main thread");
                match self.kind {
                    MenuKind::App => crate::mac::menu::set_app_menu(mtm, &specs),
                    MenuKind::Popup => crate::mac::menu::popup_menu(mtm, &specs),
                }
            }
            #[cfg(target_os = "windows")]
            {
                use crate::win::menu::MenuItemSpec;
                let Ok(specs) = serde_json::from_str::<Vec<MenuItemSpec>>(&json) else { return };
                match self.kind {
                    MenuKind::App => crate::win::menu::set_app_menu(&specs),
                    MenuKind::Popup => crate::win::menu::popup_menu(&specs),
                }
            }
        }
    }
}
