//! Global shortcut commands. Registration runs on the UI thread; presses come
//! back as `shortcut.trigger` events tagged with the caller's id.

use cef::*;
use std::cell::RefCell;

/// Returns false if the accelerator can't be parsed (validated up front so the
/// caller gets a meaningful result even though registration is async).
pub fn shortcut_register(id: u32, accelerator: String) -> bool {
    #[cfg(target_os = "macos")]
    {
        if crate::mac::shortcut::parse(&accelerator).is_none() {
            return false;
        }
        let mut task = RegisterTask::new(id, RefCell::new(Some(accelerator)));
        post_task(ThreadId::UI, Some(&mut task));
        return true;
    }
    #[allow(unreachable_code)]
    {
        let _ = (id, accelerator);
        false
    }
}

pub fn shortcut_unregister(id: u32) {
    #[cfg(target_os = "macos")]
    {
        let mut task = UnregisterTask::new(id);
        post_task(ThreadId::UI, Some(&mut task));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

wrap_task! {
    struct RegisterTask {
        id: u32,
        accelerator: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            if let Some(accelerator) = self.accelerator.borrow_mut().take() {
                crate::mac::shortcut::register(self.id, &accelerator);
            }
        }
    }
}

wrap_task! {
    struct UnregisterTask {
        id: u32,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            crate::mac::shortcut::unregister(self.id);
        }
    }
}
