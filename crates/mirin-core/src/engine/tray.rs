//! Tray commands. Creation/teardown run on the UI thread; clicks come back as
//! `tray.click` (no-menu trays) or `menu.click` (menu item) events.

use cef::*;
use std::cell::RefCell;

pub fn tray_create(spec_json: String) {
    let mut task = CreateTrayTask::new(RefCell::new(Some(spec_json)));
    post_task(ThreadId::UI, Some(&mut task));
}

pub fn tray_destroy(id: u32) {
    let mut task = DestroyTrayTask::new(id);
    post_task(ThreadId::UI, Some(&mut task));
}

wrap_task! {
    struct CreateTrayTask {
        spec_json: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            if let Some(json) = self.spec_json.borrow_mut().take() {
                crate::mac::tray::create(&json);
            }
        }
    }
}

wrap_task! {
    struct DestroyTrayTask {
        id: u32,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            crate::mac::tray::destroy(self.id);
        }
    }
}
