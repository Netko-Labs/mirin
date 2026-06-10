//! Dialog command. Async by contract: `dialog_show` posts a UI task that runs
//! the native panel modally and emits a `dialog.result` event tagged with the
//! caller's `requestId`, which the Worker correlates to its pending promise.

use cef::*;
use serde::Deserialize;
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
    let mut task = DialogTask::new(RefCell::new(Some(spec_json)));
    post_task(ThreadId::UI, Some(&mut task));
}

wrap_task! {
    struct DialogTask {
        spec_json: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            let Some(json) = self.spec_json.borrow_mut().take() else { return };
            let Ok(spec) = serde_json::from_str::<DialogSpec>(&json) else { return };
            #[cfg(target_os = "macos")]
            run(&spec);
            #[cfg(not(target_os = "macos"))]
            let _ = spec;
        }
    }
}

#[cfg(target_os = "macos")]
fn run(spec: &DialogSpec) {
    let mtm = objc2::MainThreadMarker::new().expect("dialog on main thread");
    let value = match spec.kind.as_str() {
        "openFile" => match crate::mac::dialog::open_file(mtm, spec) {
            Some(paths) => {
                let items = paths
                    .iter()
                    .map(|p| serde_json::Value::String(p.clone()))
                    .collect();
                serde_json::Value::Array(items)
            }
            None => serde_json::Value::Null,
        },
        "saveFile" => match crate::mac::dialog::save_file(mtm, spec) {
            Some(path) => serde_json::Value::String(path),
            None => serde_json::Value::Null,
        },
        "message" => {
            let button = crate::mac::dialog::message(mtm, spec);
            serde_json::json!({ "button": button })
        }
        _ => serde_json::Value::Null,
    };

    let event = serde_json::json!({
        "type": "dialog.result",
        "requestId": spec.request_id,
        "value": value,
    });
    crate::engine::emit_event(&event.to_string());
}
