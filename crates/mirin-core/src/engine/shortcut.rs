//! Global shortcut commands. Registration runs on the UI thread; presses come
//! back as `shortcut.trigger` events tagged with the caller's id.

use cef::*;
use std::cell::RefCell;

/// Returns false if the accelerator can't be parsed (validated up front so the
/// caller gets a meaningful result even though registration is async).
pub fn shortcut_register(id: u32, accelerator: String) -> bool {
    if !accelerator_valid(&accelerator) {
        return false;
    }
    let mut task = RegisterTask::new(id, RefCell::new(Some(accelerator)));
    post_task(ThreadId::UI, Some(&mut task));
    true
}

pub fn shortcut_unregister(id: u32) {
    let mut task = UnregisterTask::new(id);
    post_task(ThreadId::UI, Some(&mut task));
}

/// Validate up front (registration is async) so the caller gets a meaningful
/// boolean even though the actual register happens on the UI thread.
fn accelerator_valid(accelerator: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        return crate::mac::shortcut::parse(accelerator).is_some();
    }
    #[cfg(target_os = "windows")]
    {
        return crate::win::shortcut::parse(accelerator).is_some();
    }
    #[allow(unreachable_code)]
    {
        let _ = accelerator;
        false
    }
}

wrap_task! {
    struct RegisterTask {
        id: u32,
        accelerator: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            if let Some(accelerator) = self.accelerator.borrow_mut().take() {
                #[cfg(target_os = "macos")]
                crate::mac::shortcut::register(self.id, &accelerator);
                #[cfg(target_os = "windows")]
                crate::win::shortcut::register(self.id, &accelerator);
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let _ = &accelerator;
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
            #[cfg(target_os = "windows")]
            crate::win::shortcut::unregister(self.id);
        }
    }
}
