use std::io;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
static SWAP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Atomically exchange two real sibling directories.
///
/// The updater probes this operation before terminal handoff. Unsupported
/// filesystems therefore fail while the installed app is still running.
pub fn atomic_swap_directories(left: &Path, right: &Path) -> io::Result<()> {
    validate_atomic_swap_directories(left, right)?;
    platform_atomic_swap(left, right)?;
    crate::durable_fs::sync_parent(left)
}

pub fn validate_atomic_swap_directories(left: &Path, right: &Path) -> io::Result<()> {
    crate::durable_fs::validate_real_directory(left)?;
    crate::durable_fs::validate_real_directory(right)?;
    crate::durable_fs::validate_siblings(left, right)?;
    validate_same_filesystem(left, right)
}

#[cfg(unix)]
fn validate_same_filesystem(left: &Path, right: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    if std::fs::metadata(left)?.dev() != std::fs::metadata(right)?.dev() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic swap directories are on different filesystems",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn validate_same_filesystem(left: &Path, right: &Path) -> io::Result<()> {
    if directory_volume_serial(left)? != directory_volume_serial(right)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic swap directories are on different volumes",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn directory_volume_serial(path: &Path) -> io::Result<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: path is a live NUL-terminated UTF-16 buffer.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: handle is valid and information points to writable storage.
    let result = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) };
    // SAFETY: handle is exclusively owned here.
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetFileInformationByHandle reported success.
    Ok(unsafe { information.assume_init() }.dwVolumeSerialNumber)
}

#[cfg(target_os = "linux")]
fn platform_atomic_swap(left: &Path, right: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let left = CString::new(left.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a null byte"))?;
    let right = CString::new(right.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a null byte"))?;
    // SAFETY: both C strings remain alive for the call and AT_FDCWD makes the
    // absolute updater paths independent of the helper's working directory.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn platform_atomic_swap(left: &Path, right: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let left = CString::new(left.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a null byte"))?;
    let right = CString::new(right.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a null byte"))?;
    // SAFETY: both C strings remain alive for the call. RENAME_SWAP is one
    // filesystem transaction, so the canonical app name is never absent.
    let result = unsafe { libc::renamex_np(left.as_ptr(), right.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn platform_atomic_swap(left: &Path, right: &Path) -> io::Result<()> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CommitTransaction, CreateTransaction, RollbackTransaction,
    };

    struct Transaction(windows_sys::Win32::Foundation::HANDLE);

    impl Drop for Transaction {
        fn drop(&mut self) {
            // SAFETY: this type exclusively owns the valid transaction handle.
            unsafe {
                RollbackTransaction(self.0);
                CloseHandle(self.0);
            }
        }
    }

    let parent = left.parent().expect("validated sibling path has a parent");
    let temporary = unused_swap_path(parent)?;
    let left = wide_path(left);
    let right = wide_path(right);
    let temporary = wide_path(&temporary);

    // SAFETY: all pointers are either null or point to live NUL-terminated
    // UTF-16 buffers. The handle is closed by Transaction on every path.
    let handle = unsafe { CreateTransaction(null_mut(), null_mut(), 0, 0, 0, 0, null()) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let transaction = Transaction(handle);

    move_transacted(&left, &temporary, transaction.0)?;
    move_transacted(&right, &left, transaction.0)?;
    move_transacted(&temporary, &right, transaction.0)?;
    // SAFETY: the handle is valid and exclusively owned here.
    if unsafe { CommitTransaction(transaction.0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Commit succeeded. Close without asking Drop to roll back the committed
    // transaction (which is harmless but obscures error diagnosis).
    let handle = transaction.0;
    std::mem::forget(transaction);
    // SAFETY: ownership was moved out of Transaction immediately above.
    unsafe {
        CloseHandle(handle);
    }
    Ok(())
}

#[cfg(windows)]
fn move_transacted(
    from: &[u16],
    to: &[u16],
    transaction: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<()> {
    use std::ptr::null;
    use windows_sys::Win32::Storage::FileSystem::MoveFileTransactedW;

    // SAFETY: caller supplies live NUL-terminated UTF-16 buffers and a valid
    // transaction handle. No progress callback or opaque context is used.
    if unsafe { MoveFileTransactedW(from.as_ptr(), to.as_ptr(), None, null(), 0, transaction) } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn unused_swap_path(parent: &Path) -> io::Result<PathBuf> {
    for _ in 0..32 {
        let sequence = SWAP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".mirin-atomic-swap-{}-{sequence}",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate atomic swap path",
    ))
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn unused_swap_path(_parent: &Path) -> io::Result<PathBuf> {
    unreachable!("only Windows TxF requires a third path")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn exchanges_two_directories_without_removing_either_name() {
        let root = std::env::temp_dir().join(format!(
            "mirin-atomic-swap-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time must be valid")
                .as_nanos()
        ));
        let left = root.join("left");
        let right = root.join("right");
        fs::create_dir_all(&left).unwrap();
        fs::create_dir_all(&right).unwrap();
        fs::write(left.join("old"), b"old").unwrap();
        fs::write(right.join("new"), b"new").unwrap();

        atomic_swap_directories(&left, &right).unwrap();

        assert!(left.is_dir());
        assert!(right.is_dir());
        assert!(left.join("new").is_file());
        assert!(right.join("old").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_operand() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("mirin-atomic-swap-link-{}", std::process::id()));
        let left = root.join("left");
        let right = root.join("right");
        fs::create_dir_all(&left).unwrap();
        symlink(&left, &right).unwrap();
        assert_eq!(
            atomic_swap_directories(&left, &right).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        fs::remove_dir_all(root).unwrap();
    }
}
