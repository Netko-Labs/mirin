//! Native dialogs via NSOpenPanel / NSSavePanel / NSAlert, run modally on the
//! UI thread.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSModalResponseOK, NSOpenPanel, NSSavePanel};
use objc2_foundation::NSString;

use crate::engine::dialog::DialogSpec;

/// Returns the chosen path(s), or None if cancelled.
pub fn open_file(mtm: MainThreadMarker, spec: &DialogSpec) -> Option<Vec<String>> {
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(!spec.directories);
    panel.setCanChooseDirectories(spec.directories);
    panel.setAllowsMultipleSelection(spec.multiple);
    if let Some(message) = &spec.message {
        panel.setMessage(Some(&NSString::from_str(message)));
    }

    if panel.runModal() != NSModalResponseOK {
        return None;
    }

    let paths = panel
        .URLs()
        .iter()
        .filter_map(|url| url.path().map(|p| p.to_string()))
        .collect();
    Some(paths)
}

/// Returns the chosen path, or None if cancelled.
pub fn save_file(mtm: MainThreadMarker, spec: &DialogSpec) -> Option<String> {
    let panel = NSSavePanel::savePanel(mtm);
    if let Some(name) = &spec.default_name {
        panel.setNameFieldStringValue(&NSString::from_str(name));
    }
    if let Some(message) = &spec.message {
        panel.setMessage(Some(&NSString::from_str(message)));
    }

    if panel.runModal() != NSModalResponseOK {
        return None;
    }
    panel.URL()?.path().map(|p| p.to_string())
}

/// Shows an alert; returns the 0-based index of the clicked button.
pub fn message(mtm: MainThreadMarker, spec: &DialogSpec) -> i64 {
    const FIRST_BUTTON_RETURN: isize = 1000; // NSAlertFirstButtonReturn
    let alert = NSAlert::new(mtm);
    if let Some(text) = &spec.message {
        alert.setMessageText(&NSString::from_str(text));
    }
    if let Some(detail) = &spec.detail {
        alert.setInformativeText(&NSString::from_str(detail));
    }
    let buttons = if spec.buttons.is_empty() {
        vec!["OK".to_string()]
    } else {
        spec.buttons.clone()
    };
    for title in &buttons {
        alert.addButtonWithTitle(&NSString::from_str(title));
    }
    (alert.runModal() - FIRST_BUTTON_RETURN) as i64
}
