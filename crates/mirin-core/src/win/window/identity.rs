use std::fmt::Write;

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

use super::create::{class_name_for, set_class_identity, wide};

const MAX_WINDOWS_IDENTITY_KEY_UNITS: usize = 96;
const COMPACT_IDENTITY_PREFIX_CHARS: usize = 48;
const COMPACT_IDENTITY_HASH_BYTES: usize = 16;

/// The host exe's file stem (the app name): the fallback identity key when a
/// validated bundle identifier is unavailable. Falls back to "App".
fn exe_file_stem() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "App".to_string())
}

fn app_identity_key(dev: bool, identifier: &str) -> String {
    let raw = if identifier.is_empty() {
        exe_file_stem()
    } else {
        identifier.to_owned()
    };
    let identifier: String = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let candidate = if dev {
        format!("{identifier}-dev")
    } else {
        identifier
    };
    if raw == identifier && candidate.encode_utf16().count() <= MAX_WINDOWS_IDENTITY_KEY_UNITS {
        return candidate;
    }

    let mut hasher = Sha256::new();
    hasher.update(if dev {
        &b"dev\0"[..]
    } else {
        &b"release\0"[..]
    });
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let mut hash = String::with_capacity(COMPACT_IDENTITY_HASH_BYTES * 2);
    for byte in &digest[..COMPACT_IDENTITY_HASH_BYTES] {
        write!(&mut hash, "{byte:02x}").expect("writing to a String cannot fail");
    }
    let prefix: String = candidate
        .chars()
        .take(COMPACT_IDENTITY_PREFIX_CHARS)
        .collect();
    format!("{prefix}-{hash}")
}

/// Try to take the app's single-instance lock (a named mutex). Returns true if
/// this is the first/only instance, false if another instance already holds it.
/// The handle is intentionally leaked so the lock lives for the whole process.
pub fn acquire_single_instance(dev: bool, identifier: &str) -> bool {
    let name: Vec<u16> = format!(
        "Local\\mirin.{}.singleton",
        app_identity_key(dev, identifier)
    )
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
    // SAFETY: a standard named-mutex creation; we own or close the returned handle.
    unsafe {
        let h = CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr());
        if h.is_null() {
            return true;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(h);
            return false;
        }
        let _ = h;
        true
    }
}

/// Bring an already-running instance's window to the foreground (best-effort).
pub fn activate_existing_instance(dev: bool, identifier: &str) {
    let class = class_name_for(&app_identity_key(dev, identifier));
    // SAFETY: FindWindowW by class name; returns null when not found.
    unsafe {
        let hwnd = FindWindowW(class.as_ptr(), std::ptr::null());
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
    }
}

/// Give the process an explicit AppUserModelID so the taskbar groups this app
/// under its own identity.
pub fn set_app_id(dev: bool, identifier: &str) {
    let key = app_identity_key(dev, identifier);
    set_class_identity(&key);
    let id = wide(&format!("mirin.{key}"));
    // SAFETY: valid null-terminated wide string; the returned HRESULT is ignorable.
    unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
}

#[cfg(test)]
mod tests {
    use super::super::create::{class_name_for, wide};
    use super::{app_identity_key, MAX_WINDOWS_IDENTITY_KEY_UNITS};

    #[test]
    fn singleton_key_uses_bundle_identity_instead_of_executable_name() {
        assert_eq!(
            app_identity_key(false, "dev.example.first"),
            "dev.example.first"
        );
        assert_eq!(
            app_identity_key(true, "dev.example.second"),
            "dev.example.second-dev"
        );
        assert_ne!(
            class_name_for(&app_identity_key(false, "dev.example.first")),
            class_name_for(&app_identity_key(false, "dev.example.second"))
        );
    }

    #[test]
    fn windows_identity_is_bounded_and_stable_for_maximum_bundle_ids() {
        let identifier = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );
        assert_eq!(identifier.len(), 253);

        let key = app_identity_key(false, &identifier);
        assert_eq!(key, app_identity_key(false, &identifier));
        assert_ne!(key, app_identity_key(true, &identifier));
        assert_ne!(
            key,
            app_identity_key(false, &format!("{}e", &identifier[..252]))
        );
        assert!(key.encode_utf16().count() <= MAX_WINDOWS_IDENTITY_KEY_UNITS);
        assert!(class_name_for(&key).len() <= 257);
        assert!(wide(&format!("mirin.{key}")).len() <= 129);
    }
}
