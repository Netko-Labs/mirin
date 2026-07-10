use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

use super::create::{class_name, wide};

/// The host exe's file stem (the app name): the basis for the AppUserModelID and
/// the single-instance lock. Falls back to "App".
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

/// Try to take the app's single-instance lock (a named mutex). Returns true if
/// this is the first/only instance, false if another instance already holds it.
/// The handle is intentionally leaked so the lock lives for the whole process.
pub fn acquire_single_instance(dev: bool) -> bool {
    let name: Vec<u16> = format!("Local\\mirin.{}.singleton", app_key(dev))
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
