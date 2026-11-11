//! Downloads started by page content (`<a download>`, `Content-Disposition:
//! attachment`, blob URLs). Without a download handler CEF cancels them
//! silently; with one, the user gets a native "Save as" picker.
//!
//! macOS/Windows let CEF show its own native dialog (`show_dialog = 1`). On
//! Linux CEF's built-in picker is GTK-only and unreliable under Ozone/X11, so
//! the mirin portal dialog (`linux/dialog.rs`) runs on a thread and the chosen
//! path is handed back to CEF on the UI thread.

use cef::*;
#[cfg(target_os = "linux")]
use std::cell::RefCell;

#[cfg(target_os = "linux")]
use crate::engine::dialog::DialogSpec;

wrap_download_handler! {
    pub struct MirinDownloadHandler;

    impl DownloadHandler {
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> ::std::os::raw::c_int {
            1
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> ::std::os::raw::c_int {
            let Some(callback) = callback else { return 0 };
            let suggested = suggested_name.map(|name| name.to_string()).unwrap_or_default();
            start_download(callback.clone(), suggested);
            1
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn start_download(callback: BeforeDownloadCallback, _suggested: String) {
    // CEF's own native save panel (NSSavePanel / IFileSaveDialog).
    callback.cont(None, 1);
}

#[cfg(target_os = "linux")]
fn start_download(callback: BeforeDownloadCallback, suggested: String) {
    std::thread::Builder::new()
        .name("mirin-download".into())
        .spawn(move || {
            let spec = DialogSpec {
                request_id: 0,
                kind: "saveFile".into(),
                title: Some("Save".into()),
                message: None,
                detail: None,
                buttons: Vec::new(),
                multiple: false,
                directories: false,
                default_name: (!suggested.is_empty()).then_some(suggested),
            };
            // Dropping the callback without `cont` cancels the download, which is
            // exactly what a cancelled picker should do.
            if let Some(path) = crate::linux::dialog::save_file(&spec) {
                let mut task = ContinueDownloadTask::new(RefCell::new(Some(callback)), path);
                post_task(ThreadId::UI, Some(&mut task));
            }
        })
        .ok();
}

#[cfg(target_os = "linux")]
wrap_task! {
    struct ContinueDownloadTask {
        callback: RefCell<Option<BeforeDownloadCallback>>,
        path: String,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            if let Some(callback) = self.callback.borrow_mut().take() {
                callback.cont(Some(&CefString::from(self.path.as_str())), 0);
            }
        }
    }
}
