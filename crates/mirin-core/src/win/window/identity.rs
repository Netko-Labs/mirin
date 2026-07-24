use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

use super::create::{class_name, wide};

/// The host exe's file stem (the app name): the basis for the AppUserModelID
/// and the fallback single-instance key. Falls back to "App".
fn exe_file_stem() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "App".to_string())
}

/// The app's identity key for the AUMID + single-instance lock.
fn app_key(dev: bool) -> String {
    let stem = exe_file_stem();
    if dev {
        format!("{stem}-dev")
    } else {
        stem
    }
}

fn singleton_key(dev: bool, identifier: &str) -> String {
    let identifier: String = identifier
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let key = if identifier.is_empty() {
        exe_file_stem()
    } else {
        identifier
    };
    if dev {
        format!("{key}-dev")
    } else {
        key
    }
}

/// Try to take the app's single-instance lock (a named mutex). Returns true if
/// this is the first/only instance, false if another instance already holds it.
/// The handle is intentionally leaked so the lock lives for the whole process.
pub fn acquire_single_instance(dev: bool, identifier: &str) -> bool {
    let name: Vec<u16> = format!("Local\\mirin.{}.singleton", singleton_key(dev, identifier))
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
pub fn activate_existing_instance() {
    let class = class_name();
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
pub fn set_app_id(dev: bool) {
    let id = wide(&format!("mirin.{}", app_key(dev)));
    // SAFETY: valid null-terminated wide string; the returned HRESULT is ignorable.
    unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
}

#[cfg(test)]
mod tests {
    use super::singleton_key;

    #[test]
    fn singleton_key_uses_bundle_identity_instead_of_executable_name() {
        assert_eq!(
            singleton_key(false, "dev.example.first"),
            "dev.example.first"
        );
        assert_eq!(
            singleton_key(true, "dev.example.second"),
            "dev.example.second-dev"
        );
    }
}
