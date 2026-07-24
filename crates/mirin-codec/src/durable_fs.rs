use std::ffi::OsString;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

static DURABLE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn sync_tree(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        return sync_file(path);
    }
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable tree contains an unsupported file type",
        ));
    }

    for entry in fs::read_dir(path)? {
        sync_tree(&entry?.path())?;
    }
    sync_directory(path)
}

pub fn sync_parent(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable path must have a parent directory",
        )
    })?;
    sync_directory(parent)
}

pub fn durable_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = unused_temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn durable_move_directory(source: &Path, destination: &Path) -> io::Result<()> {
    validate_real_directory(source)?;
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "durable move destination already exists",
        ));
    }
    validate_siblings(source, destination)?;
    move_directory(source, destination)?;
    sync_parent(destination)
}

pub fn durable_remove_directory(path: &Path) -> io::Result<()> {
    validate_real_directory(path)?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable directory must have a parent",
        )
    })?;
    fs::remove_dir_all(path)?;
    sync_directory(parent)
}

pub fn durable_remove_file(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable file removal requires a real file",
        ));
    }
    fs::remove_file(path)?;
    sync_parent(path)
}

pub(crate) fn validate_real_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be a real directory",
        ));
    }
    #[cfg(windows)]
    if metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory reparse points cannot participate in updater swaps",
        ));
    }
    Ok(())
}

pub(crate) fn validate_siblings(left: &Path, right: &Path) -> io::Result<()> {
    if left == right {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "paths must be different",
        ));
    }
    if left.parent() != right.parent() || left.parent().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "paths must be siblings",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(unix)]
fn sync_file(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?
        .sync_all()
}

#[cfg(windows)]
fn sync_file(path: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)?
        .sync_all()
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    move_file_ex(
        source,
        destination,
        windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
            | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
    )
}

#[cfg(unix)]
fn move_directory(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn move_directory(source: &Path, destination: &Path) -> io::Result<()> {
    move_file_ex(
        source,
        destination,
        windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
    )
}

#[cfg(windows)]
fn move_file_ex(source: &Path, destination: &Path, flags: u32) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are live, NUL-terminated UTF-16 paths.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unused_temporary_path(destination: &Path) -> io::Result<PathBuf> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must have a parent",
        )
    })?;
    let name = destination.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "durable destination must have a file name",
        )
    })?;
    for _ in 0..32 {
        let sequence = DURABLE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = OsString::from(".");
        temporary_name.push(name);
        temporary_name.push(format!(".mirin-{}-{sequence}.tmp", std::process::id()));
        let candidate = parent.join(temporary_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate durable temporary file",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn durable_operations_commit_files_and_directories() {
        let root = std::env::temp_dir().join(format!(
            "mirin-durable-fs-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time must be valid")
                .as_nanos()
        ));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        durable_write(&source.join("receipt"), b"ready").unwrap();
        sync_tree(&source).unwrap();
        durable_move_directory(&source, &destination).unwrap();
        assert_eq!(fs::read(destination.join("receipt")).unwrap(), b"ready");
        durable_remove_file(&destination.join("receipt")).unwrap();
        durable_remove_directory(&destination).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
