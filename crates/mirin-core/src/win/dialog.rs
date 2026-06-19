//! Native dialogs — the Windows analogue of `mac/dialog.rs`. File open/save use
//! the common file dialogs (comdlg32); message dialogs use `MessageBox`. Each runs
//! modally on the UI thread; the engine wraps the result in a `dialog.result`
//! event tagged with the caller's `requestId`.

use crate::engine::dialog::DialogSpec;

use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Controls::Dialogs::{
    GetOpenFileNameW, GetSaveFileNameW, OPENFILENAMEW, OFN_ALLOWMULTISELECT, OFN_EXPLORER,
    OFN_FILEMUSTEXIST, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST,
};
use windows_sys::Win32::UI::Shell::{
    SHBrowseForFolderW, SHGetPathFromIDListW, BIF_RETURNONLYFSDIRS, BROWSEINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, MessageBoxW, IDCANCEL, IDNO, IDOK, IDYES, MB_ICONINFORMATION, MB_OK,
    MB_OKCANCEL, MB_YESNOCANCEL,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a NUL-terminated wide buffer into a String.
fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// A modal message box. Returns the index of the chosen button to match the
/// `buttons` array the caller passed (custom labels aren't shown by MessageBox —
/// Windows uses standard OK/Cancel/Yes-No sets; the returned index still lines up
/// with the array's [confirm, …, cancel] order).
pub fn message(spec: &DialogSpec) -> i64 {
    let mut text = spec.message.clone().unwrap_or_default();
    if let Some(detail) = &spec.detail {
        text.push_str("\n\n");
        text.push_str(detail);
    }
    let n = spec.buttons.len();
    let style = match n {
        0 | 1 => MB_OK,
        2 => MB_OKCANCEL,
        _ => MB_YESNOCANCEL,
    } | MB_ICONINFORMATION;

    let text_w = wide(&text);
    let title_w = wide(spec.title.as_deref().unwrap_or(""));
    // SAFETY: foreground owner + NUL-terminated wide strings that outlive the call.
    let result = unsafe { MessageBoxW(GetForegroundWindow(), text_w.as_ptr(), title_w.as_ptr(), style) };

    match result {
        IDOK | IDYES => 0,
        IDNO => 1,
        IDCANCEL => (n.max(1) - 1) as i64,
        _ => 0,
    }
}

fn base_ofn(buf: &mut [u16], title: &Option<Vec<u16>>) -> OPENFILENAMEW {
    // SAFETY: OPENFILENAMEW is plain data; zero then set the fields we use.
    let mut ofn: OPENFILENAMEW = unsafe { core::mem::zeroed() };
    ofn.lStructSize = core::mem::size_of::<OPENFILENAMEW>() as u32;
    // SAFETY: pure query.
    ofn.hwndOwner = unsafe { GetForegroundWindow() };
    ofn.lpstrFile = buf.as_mut_ptr();
    ofn.nMaxFile = buf.len() as u32;
    if let Some(t) = title {
        ofn.lpstrTitle = t.as_ptr();
    }
    ofn
}

/// Open-file (or folder) dialog. Supports `directories` (folder picker) and
/// `multiple` (multi-select). Returns None on cancel.
pub fn open_file(spec: &DialogSpec) -> Option<Vec<String>> {
    if spec.directories {
        return pick_folder(spec);
    }
    // Multi-select needs a large buffer (dir\0file1\0file2\0\0).
    let mut buf = vec![0u16; if spec.multiple { 32768 } else { 4096 }];
    let title = spec.title.as_deref().map(wide);
    let mut ofn = base_ofn(&mut buf, &title);
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER;
    if spec.multiple {
        ofn.Flags |= OFN_ALLOWMULTISELECT;
    }
    // SAFETY: ofn is fully initialized; its string buffers outlive the call.
    let ok = unsafe { GetOpenFileNameW(&mut ofn) } != 0;
    if !ok {
        return None;
    }
    Some(parse_open_result(&buf))
}

/// Parse `GetOpenFileNameW`'s buffer. With `OFN_ALLOWMULTISELECT` and multiple
/// files chosen it is `dir\0file1\0file2\0\0`; otherwise a single full path.
fn parse_open_result(buf: &[u16]) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut start = 0;
    for (i, &c) in buf.iter().enumerate() {
        if c == 0 {
            if i == start {
                break; // double NUL → end
            }
            parts.push(String::from_utf16_lossy(&buf[start..i]));
            start = i + 1;
        }
    }
    match parts.split_first() {
        None => Vec::new(),
        // Single selection → one absolute path.
        Some((only, [])) => vec![only.clone()],
        // Multi: first part is the directory, the rest file names within it.
        Some((dir, files)) => files.iter().map(|f| format!("{dir}\\{f}")).collect(),
    }
}

/// Folder picker via the shell browse dialog.
fn pick_folder(spec: &DialogSpec) -> Option<Vec<String>> {
    let title = spec.title.as_deref().map(wide);
    let mut bi: BROWSEINFOW = unsafe { core::mem::zeroed() };
    // SAFETY: pure query.
    bi.hwndOwner = unsafe { GetForegroundWindow() };
    if let Some(t) = &title {
        bi.lpszTitle = t.as_ptr();
    }
    bi.ulFlags = BIF_RETURNONLYFSDIRS;
    // SAFETY: bi is valid; the returned PIDL is freed with CoTaskMemFree.
    unsafe {
        let pidl = SHBrowseForFolderW(&mut bi);
        if pidl.is_null() {
            return None;
        }
        let mut path = [0u16; 260];
        let ok = SHGetPathFromIDListW(pidl, path.as_mut_ptr()) != 0;
        CoTaskMemFree(pidl as *const _);
        ok.then(|| vec![wide_to_string(&path)])
    }
}

/// Save-file dialog. Returns the chosen path, or None on cancel.
pub fn save_file(spec: &DialogSpec) -> Option<String> {
    let mut buf = vec![0u16; 4096];
    if let Some(name) = &spec.default_name {
        for (i, c) in name.encode_utf16().take(buf.len() - 1).enumerate() {
            buf[i] = c;
        }
    }
    let title = spec.title.as_deref().map(wide);
    let mut ofn = base_ofn(&mut buf, &title);
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_EXPLORER;
    // SAFETY: as above.
    let ok = unsafe { GetSaveFileNameW(&mut ofn) } != 0;
    ok.then(|| wide_to_string(&buf))
}
