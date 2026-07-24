use super::CoreConfig;
use std::{
    fs::{create_dir_all, File, OpenOptions},
    path::Path,
    sync::OnceLock,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstanceLock {
    Unavailable = 0,
    Shared = 1,
    Exclusive = 2,
}

static ACQUIRED: OnceLock<InstanceLock> = OnceLock::new();
static LOCK_FILE: OnceLock<File> = OnceLock::new();

#[cfg(unix)]
use std::{os::fd::AsRawFd, os::unix::fs::OpenOptionsExt};

#[cfg(target_os = "windows")]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

/// Acquire the process-lifetime app lock before the Bun Worker starts.
///
/// Single-instance apps take an exclusive lock. Multi-instance apps take a
/// shared lock, so they can coexist with each other but never with an exclusive
/// updater-capable process. Repeated calls return the first result.
pub fn acquire_instance_lock(config: &CoreConfig) -> InstanceLock {
    *ACQUIRED.get_or_init(|| acquire_platform_lock(config))
}

fn acquire_platform_lock(config: &CoreConfig) -> InstanceLock {
    let cache = super::boot::default_cache_dir(config.dev, &config.identifier);
    let Some(parent) = Path::new(&cache).parent() else {
        return InstanceLock::Unavailable;
    };
    if let Err(error) = create_dir_all(parent) {
        eprintln!("[mirin] could not create instance-lock directory: {error}");
        return InstanceLock::Unavailable;
    }
    let requested = if config.single_instance {
        InstanceLock::Exclusive
    } else {
        InstanceLock::Shared
    };
    let path = parent.join(".instance.lock");
    let Some(file) = try_lock_file(&path, requested) else {
        #[cfg(target_os = "windows")]
        if config.single_instance {
            crate::win::activate_existing_instance();
        }
        return InstanceLock::Unavailable;
    };

    #[cfg(target_os = "windows")]
    if config.single_instance && !crate::win::acquire_single_instance(config.dev) {
        crate::win::activate_existing_instance();
        return InstanceLock::Unavailable;
    }

    if LOCK_FILE.set(file).is_err() {
        return InstanceLock::Unavailable;
    }
    requested
}

#[cfg(unix)]
fn try_lock_file(path: &Path, requested: InstanceLock) -> Option<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .ok()?;
    // SAFETY: flock receives a valid descriptor owned by `file`; the descriptor
    // stays open in LOCK_FILE for the process lifetime after successful acquire.
    let mode = match requested {
        InstanceLock::Shared => libc::LOCK_SH,
        InstanceLock::Exclusive => libc::LOCK_EX,
        InstanceLock::Unavailable => return None,
    };
    let result = unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) };
    (result == 0).then_some(file)
}

#[cfg(target_os = "windows")]
fn try_lock_file(path: &Path, requested: InstanceLock) -> Option<File> {
    let share_mode = match requested {
        InstanceLock::Shared => FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        InstanceLock::Exclusive => 0,
        InstanceLock::Unavailable => return None,
    };
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(share_mode)
        .open(path)
        .ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::{try_lock_file, InstanceLock};
    use std::{
        fs::remove_file,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn exclusive_and_shared_locks_exclude_each_other() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow the epoch")
            .as_nanos();
        let path = PathBuf::from(format!(
            "{}/mirin-singleton-{}-{nonce}.lock",
            std::env::temp_dir().display(),
            std::process::id()
        ));
        let first_shared =
            try_lock_file(&path, InstanceLock::Shared).expect("first shared lock should succeed");
        let second_shared =
            try_lock_file(&path, InstanceLock::Shared).expect("second shared lock should succeed");
        assert!(try_lock_file(&path, InstanceLock::Exclusive).is_none());
        drop(first_shared);
        drop(second_shared);

        let exclusive = try_lock_file(&path, InstanceLock::Exclusive)
            .expect("exclusive lock should succeed after shared locks close");
        assert!(try_lock_file(&path, InstanceLock::Shared).is_none());
        drop(exclusive);
        remove_file(path).expect("singleton test lock should be removable");
    }
}
