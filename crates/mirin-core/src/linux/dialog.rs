//! Linux dialogs. File pickers go through the **xdg-desktop-portal**
//! `FileChooser` interface over the session bus, so the desktop (KDE, GNOME,
//! …) shows its own native picker and the app works the same under Wayland,
//! X11, Flatpak, and sandboxes. Message boxes have no portal; they shell out to
//! `zenity` or `kdialog`, whichever the desktop ships.
//!
//! Everything here **blocks** until the user answers, so the engine runs it on
//! a dedicated thread rather than the CEF UI thread (`engine/dialog.rs`).

use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::engine::dialog::DialogSpec;

const PORTAL_BUS: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const FILE_CHOOSER: &str = "org.freedesktop.portal.FileChooser";
const REQUEST: &str = "org.freedesktop.portal.Request";

/// Portal response code for "the user picked something".
const RESPONSE_SUCCESS: u32 = 0;

static NEXT_TOKEN: AtomicU32 = AtomicU32::new(1);

/// Returns the chosen path(s), or None if cancelled or the portal is missing.
pub fn open_file(spec: &DialogSpec) -> Option<Vec<String>> {
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("multiple", Value::from(spec.multiple));
    options.insert("directory", Value::from(spec.directories));
    options.insert("modal", Value::from(true));
    let title = spec
        .title
        .as_deref()
        .or(spec.message.as_deref())
        .unwrap_or(if spec.directories {
            "Choose a folder"
        } else {
            "Open"
        });
    let paths = file_chooser("OpenFile", title, options)?;
    (!paths.is_empty()).then_some(paths)
}

/// Returns the chosen path, or None if cancelled or the portal is missing.
pub fn save_file(spec: &DialogSpec) -> Option<String> {
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("modal", Value::from(true));
    if let Some(name) = spec.default_name.as_deref() {
        options.insert("current_name", Value::from(name));
    }
    let title = spec
        .title
        .as_deref()
        .or(spec.message.as_deref())
        .unwrap_or("Save");
    file_chooser("SaveFile", title, options)?.into_iter().next()
}

/// Shows a message box; returns the 0-based index of the clicked button.
/// Falls back to button 0 when neither `zenity` nor `kdialog` is available.
pub fn message(spec: &DialogSpec) -> i64 {
    let buttons: Vec<String> = if spec.buttons.is_empty() {
        vec!["OK".to_string()]
    } else {
        spec.buttons.clone()
    };
    let text = match (&spec.message, &spec.detail) {
        (Some(message), Some(detail)) => format!("{message}\n\n{detail}"),
        (Some(message), None) => message.clone(),
        (None, Some(detail)) => detail.clone(),
        (None, None) => String::new(),
    };
    let title = spec.title.as_deref().unwrap_or("");
    if let Some(index) = zenity_message(title, &text, &buttons) {
        return index;
    }
    if let Some(index) = kdialog_message(title, &text, &buttons) {
        return index;
    }
    eprintln!("[mirin] dialog.message: neither zenity nor kdialog found; answering button 0");
    0
}

/// One portal `FileChooser` round trip: subscribe to the request's `Response`
/// signal *before* calling, so a fast answer cannot be missed, then block on it.
fn file_chooser(
    method: &str,
    title: &str,
    mut options: HashMap<&str, Value<'_>>,
) -> Option<Vec<String>> {
    let connection = match Connection::session() {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("[mirin] dialog: no session bus ({error}); is xdg-desktop-portal running?");
            return None;
        }
    };
    let token = format!("mirin{}", NEXT_TOKEN.fetch_add(1, Ordering::Relaxed));
    let expected_path = request_path(connection.unique_name().map(|name| name.as_str()), &token)?;
    options.insert("handle_token", Value::from(token.clone()));

    let request = Proxy::new(&connection, PORTAL_BUS, expected_path.as_str(), REQUEST).ok()?;
    let mut responses = request.receive_signal("Response").ok()?;

    let chooser = Proxy::new(&connection, PORTAL_BUS, PORTAL_PATH, FILE_CHOOSER).ok()?;
    // `parent_window` is empty: CEF owns the toplevel and exporting an XDG
    // foreign handle for it is a follow-up; `modal` still keeps the picker on top.
    let handle: OwnedObjectPath = match chooser.call(method, &("", title, options)) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("[mirin] dialog: portal {method} failed: {error}");
            return None;
        }
    };

    // Portals older than 0.9 ignore `handle_token` and mint their own path;
    // re-subscribe there (the tiny race is the documented trade-off).
    if handle.as_str() != expected_path {
        let request = Proxy::new(&connection, PORTAL_BUS, handle.as_str(), REQUEST).ok()?;
        responses = request.receive_signal("Response").ok()?;
    }

    let message = responses.next()?;
    let (code, results): (u32, HashMap<String, OwnedValue>) = message.body().deserialize().ok()?;
    if code != RESPONSE_SUCCESS {
        return None;
    }
    let uris: Vec<String> = results
        .get("uris")
        .and_then(|value| Vec::<String>::try_from(value.clone()).ok())
        .unwrap_or_default();
    Some(
        uris.iter()
            .filter_map(|uri| file_uri_to_path(uri))
            .collect(),
    )
}

/// `/org/freedesktop/portal/desktop/request/<sender>/<token>` where sender is
/// the connection's unique name without the leading `:` and with `.` → `_`.
fn request_path(unique_name: Option<&str>, token: &str) -> Option<String> {
    let sender = unique_name?.trim_start_matches(':').replace('.', "_");
    Some(format!(
        "/org/freedesktop/portal/desktop/request/{sender}/{token}"
    ))
}

/// Turn a `file://` URI into a filesystem path; other schemes are dropped.
pub(crate) fn file_uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    // Skip an optional authority (`file://localhost/x`); keep the path absolute.
    let path = match rest.find('/') {
        Some(0) => rest,
        Some(index) => &rest[index..],
        None => return None,
    };
    Some(percent_decode(path))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn zenity_message(title: &str, text: &str, buttons: &[String]) -> Option<i64> {
    let mut command = Command::new("zenity");
    command
        .arg(format!("--title={title}"))
        .arg(format!("--text={text}"));
    match buttons.len() {
        1 => {
            command
                .arg("--info")
                .arg(format!("--ok-label={}", buttons[0]));
        }
        _ => {
            command
                .arg("--question")
                .arg(format!("--ok-label={}", buttons[0]))
                .arg(format!("--cancel-label={}", buttons[1]));
            for extra in &buttons[2..] {
                command.arg(format!("--extra-button={extra}"));
            }
        }
    }
    let output = command.output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let clicked = stdout.trim();
    if !clicked.is_empty() {
        if let Some(index) = buttons.iter().position(|label| label == clicked) {
            return Some(index as i64);
        }
    }
    match output.status.code() {
        Some(0) => Some(0),
        Some(1) if buttons.len() > 1 => Some(1),
        Some(1) => Some(0),
        _ => None,
    }
}

fn kdialog_message(title: &str, text: &str, buttons: &[String]) -> Option<i64> {
    let mut command = Command::new("kdialog");
    command.arg("--title").arg(title);
    match buttons.len() {
        1 => {
            command.arg("--msgbox").arg(text);
        }
        2 => {
            command
                .arg("--yes-label")
                .arg(&buttons[0])
                .arg("--no-label")
                .arg(&buttons[1])
                .arg("--yesno")
                .arg(text);
        }
        _ => {
            command
                .arg("--yes-label")
                .arg(&buttons[0])
                .arg("--no-label")
                .arg(&buttons[1])
                .arg("--cancel-label")
                .arg(&buttons[2])
                .arg("--yesnocancel")
                .arg(text);
        }
    }
    let status = command.status().ok()?;
    // kdialog: 0 = yes/ok, 1 = no, 2 = cancel.
    match status.code() {
        Some(code @ 0..=2) => Some(i64::from(code).min(buttons.len() as i64 - 1)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_uris() {
        assert_eq!(
            file_uri_to_path("file:///home/me/My%20Export.csv").as_deref(),
            Some("/home/me/My Export.csv")
        );
        assert_eq!(
            file_uri_to_path("file://localhost/tmp/a.db").as_deref(),
            Some("/tmp/a.db")
        );
        assert_eq!(file_uri_to_path("https://example.com/x"), None);
        assert_eq!(file_uri_to_path("file://"), None);
        assert_eq!(
            file_uri_to_path("file:///caf%C3%A9.txt").as_deref(),
            Some("/café.txt")
        );
        assert_eq!(
            file_uri_to_path("file:///bad%zz").as_deref(),
            Some("/bad%zz")
        );
    }

    #[test]
    fn builds_the_request_path_from_the_unique_name() {
        assert_eq!(
            request_path(Some(":1.42"), "mirin7").as_deref(),
            Some("/org/freedesktop/portal/desktop/request/1_42/mirin7")
        );
        assert_eq!(request_path(None, "mirin7"), None);
    }
}
