//! Dialog command. Async by contract: `dialog_show` posts a UI task that runs
//! the native panel modally and emits a `dialog.result` event tagged with the
//! caller's `requestId`, which the Worker correlates to its pending promise.

#[cfg(not(target_os = "linux"))]
use cef::*;
use serde::Deserialize;
#[cfg(not(target_os = "linux"))]
use std::cell::RefCell;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogSpec {
    pub request_id: u32,
    /// "openFile" | "saveFile" | "message"
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub buttons: Vec<String>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub directories: bool,
    #[serde(default)]
    pub default_name: Option<String>,
}

pub fn dialog_show(spec_json: String) {
    // Linux dialogs are portal round trips / helper processes that block until
    // the user answers, so they get their own thread instead of the UI thread
    // (which must keep pumping CEF so the portal's picker can appear on top).
    // A spec that doesn't parse has no `requestId` to answer, on every
    // platform; the runtime builds it, so that is a bug on its side.
    #[cfg(target_os = "linux")]
    {
        let Ok(spec) = serde_json::from_str::<DialogSpec>(&spec_json) else {
            return;
        };
        let request_id = spec.request_id;
        let spawned = std::thread::Builder::new()
            .name("mirin-dialog".into())
            .spawn(move || run(&spec));
        // No thread, no dialog: answer at once, as a cancel, so the Worker's
        // promise settles.
        if spawned.is_err() {
            emit_result(request_id, serde_json::Value::Null);
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut task = DialogTask::new(RefCell::new(Some(spec_json)));
        post_task(ThreadId::UI, Some(&mut task));
    }
}

#[cfg(not(target_os = "linux"))]
wrap_task! {
    struct DialogTask {
        spec_json: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            let Some(json) = self.spec_json.borrow_mut().take() else { return };
            let Ok(spec) = serde_json::from_str::<DialogSpec>(&json) else { return };
            run(&spec);
        }
    }
}

fn run(spec: &DialogSpec) {
    let value = match spec.kind.as_str() {
        "openFile" => match open_file(spec) {
            Some(paths) => {
                serde_json::Value::Array(paths.into_iter().map(serde_json::Value::String).collect())
            }
            None => serde_json::Value::Null,
        },
        "saveFile" => match save_file(spec) {
            Some(path) => serde_json::Value::String(path),
            None => serde_json::Value::Null,
        },
        "message" => serde_json::json!({ "button": message(spec) }),
        _ => serde_json::Value::Null,
    };

    emit_result(spec.request_id, value);
}

/// The `dialog.result` event the Worker's pending promise waits for.
fn emit_result(request_id: u32, value: serde_json::Value) {
    let event = serde_json::json!({
        "type": "dialog.result",
        "requestId": request_id,
        "value": value,
    });
    crate::engine::emit_event(&event.to_string());
}

fn open_file(spec: &DialogSpec) -> Option<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        let mtm = objc2::MainThreadMarker::new().expect("dialog on main thread");
        return crate::mac::dialog::open_file(mtm, spec);
    }
    #[cfg(target_os = "windows")]
    return crate::win::dialog::open_file(spec);
    #[cfg(target_os = "linux")]
    return crate::linux::dialog::open_file(spec);
    #[allow(unreachable_code)]
    {
        let _ = spec;
        None
    }
}

fn save_file(spec: &DialogSpec) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mtm = objc2::MainThreadMarker::new().expect("dialog on main thread");
        return crate::mac::dialog::save_file(mtm, spec);
    }
    #[cfg(target_os = "windows")]
    return crate::win::dialog::save_file(spec);
    #[cfg(target_os = "linux")]
    return crate::linux::dialog::save_file(spec);
    #[allow(unreachable_code)]
    {
        let _ = spec;
        None
    }
}

fn message(spec: &DialogSpec) -> i64 {
    #[cfg(target_os = "macos")]
    {
        let mtm = objc2::MainThreadMarker::new().expect("dialog on main thread");
        return crate::mac::dialog::message(mtm, spec);
    }
    #[cfg(target_os = "windows")]
    return crate::win::dialog::message(spec);
    #[cfg(target_os = "linux")]
    return crate::linux::dialog::message(spec);
    #[allow(unreachable_code)]
    {
        let _ = spec;
        0
    }
}
