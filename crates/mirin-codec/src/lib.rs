//! Updater codec shared by the app runtime and the standalone release helper.

use qbsdiff::{Bsdiff, Bspatch};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_ZSTD_WINDOW_LOG: u32 = 27;
const MAX_BOUNDED_PATCH_INPUT_BYTES: u64 = 512 * 1024 * 1024;

fn limit_error(limit: u64) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("codec output exceeds {limit} bytes"),
    )
}

fn read_all(path: &str) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    File::open(path)?.read_to_end(&mut buf)?;
    Ok(buf)
}

fn read_all_bounded(path: &str, max_bytes: u64) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("codec input exceeds {max_bytes} bytes"),
        ));
    }

    let capacity = usize::try_from(file_len).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "codec input does not fit in address space",
        )
    })?;
    let mut buf = Vec::with_capacity(capacity);
    let mut reader = BufReader::new(file).take(max_bytes.saturating_add(1));
    reader.read_to_end(&mut buf)?;
    if buf.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("codec input exceeds {max_bytes} bytes"),
        ));
    }
    Ok(buf)
}

struct BoundedWriter<W> {
    inner: W,
    remaining: u64,
    limit: u64,
}

impl<W> BoundedWriter<W> {
    fn new(inner: W, limit: u64) -> Self {
        Self {
            inner,
            remaining: limit,
            limit,
        }
    }
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() as u64 > self.remaining {
            return Err(limit_error(self.limit));
        }
        let written = self.inner.write(buf)?;
        self.remaining = self.remaining.saturating_sub(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn temporary_output_path(destination: &Path) -> io::Result<PathBuf> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let file_name = destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;

    for _ in 0..32 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temp_name = OsString::from(".");
        temp_name.push(file_name);
        temp_name.push(format!(".mirin-{}-{sequence}.tmp", std::process::id()));
        let candidate = parent.join(temp_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate codec temporary output path",
    ))
}

fn write_bounded_file(
    destination: &str,
    max_output_bytes: u64,
    operation: impl FnOnce(&mut BoundedWriter<BufWriter<File>>) -> io::Result<()>,
) -> io::Result<()> {
    let destination = Path::new(destination);
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "bounded codec destination already exists",
        ));
    }

    let temporary = temporary_output_path(destination)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let mut output = BoundedWriter::new(BufWriter::new(file), max_output_bytes);
    let result = operation(&mut output).and_then(|()| output.flush());
    drop(output);

    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

pub fn zstd_compress_file(src: &str, dst: &str, level: i32) -> io::Result<()> {
    let input = File::open(src)?;
    let input_len = input.metadata()?.len();
    let output = BufWriter::new(File::create(dst)?);
    let mut encoder = zstd::stream::write::Encoder::new(output, level)?;
    let workers = thread::available_parallelism()
        .map(|count| count.get().saturating_sub(1).clamp(1, 8) as u32)
        .unwrap_or(1);
    encoder.multithread(workers)?;
    encoder.set_pledged_src_size(Some(input_len))?;
    io::copy(&mut BufReader::new(input), &mut encoder)?;
    let mut output = encoder.finish()?;
    output.flush()?;
    Ok(())
}

pub fn zstd_decompress_file(src: &str, dst: &str) -> io::Result<()> {
    let input = File::open(src)?;
    let mut output = File::create(dst)?;
    zstd::stream::copy_decode(input, &mut output)?;
    Ok(())
}

pub fn zstd_decompress_file_bounded(src: &str, dst: &str, max_output_bytes: u64) -> io::Result<()> {
    let input = File::open(src)?;
    write_bounded_file(dst, max_output_bytes, |output| {
        let mut decoder = zstd::stream::read::Decoder::new(BufReader::new(input))?;
        decoder.window_log_max(MAX_ZSTD_WINDOW_LOG)?;
        io::copy(&mut decoder, output)?;
        Ok(())
    })
}

pub fn bsdiff_file(old: &str, new: &str, patch: &str) -> io::Result<()> {
    let old = read_all(old)?;
    let new = read_all(new)?;
    let out = BufWriter::new(File::create(patch)?);
    Bsdiff::new(&old, &new).compare(out)?;
    Ok(())
}

pub fn bspatch_file(old: &str, patch: &str, new: &str) -> io::Result<()> {
    let old = read_all(old)?;
    let patch = read_all(patch)?;
    let out = BufWriter::new(File::create(new)?);
    Bspatch::new(&patch)?.apply(&old, out)?;
    Ok(())
}

pub fn bspatch_file_bounded(
    old: &str,
    patch: &str,
    new: &str,
    max_old_bytes: u64,
    max_patch_bytes: u64,
    max_output_bytes: u64,
) -> io::Result<()> {
    let old_len = File::open(old)?.metadata()?.len();
    let patch_len = File::open(patch)?.metadata()?.len();
    validate_patch_input_lengths(
        old_len,
        patch_len,
        max_old_bytes,
        max_patch_bytes,
        MAX_BOUNDED_PATCH_INPUT_BYTES,
    )?;
    let old = read_all_bounded(old, max_old_bytes)?;
    let patch = read_all_bounded(patch, max_patch_bytes)?;
    let patcher = Bspatch::new(&patch)?;
    if patcher.hint_target_size() > max_output_bytes {
        return Err(limit_error(max_output_bytes));
    }

    write_bounded_file(new, max_output_bytes, |output| {
        patcher.apply(&old, output)?;
        Ok(())
    })
}

fn validate_patch_input_lengths(
    old_bytes: u64,
    patch_bytes: u64,
    max_old_bytes: u64,
    max_patch_bytes: u64,
    max_total_bytes: u64,
) -> io::Result<()> {
    if old_bytes > max_old_bytes || patch_bytes > max_patch_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "codec patch input exceeds its declared limit",
        ));
    }
    if old_bytes
        .checked_add(patch_bytes)
        .is_none_or(|total| total > max_total_bytes)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("codec patch inputs exceed {max_total_bytes} bytes"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mirin-codec-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time must be after the Unix epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        root
    }

    #[test]
    fn compression_and_patch_round_trip() {
        let root = test_root("round-trip");
        let old = root.join("old");
        let new = root.join("new");
        let compressed = root.join("new.zst");
        let decoded = root.join("decoded");
        let patch = root.join("patch");
        let patched = root.join("patched");
        fs::write(&old, b"Anko release alpha").unwrap();
        fs::write(&new, b"Anko release arm64 with MCP").unwrap();

        zstd_compress_file(new.to_str().unwrap(), compressed.to_str().unwrap(), 3).unwrap();
        zstd_decompress_file(compressed.to_str().unwrap(), decoded.to_str().unwrap()).unwrap();
        bsdiff_file(
            old.to_str().unwrap(),
            new.to_str().unwrap(),
            patch.to_str().unwrap(),
        )
        .unwrap();
        bspatch_file(
            old.to_str().unwrap(),
            patch.to_str().unwrap(),
            patched.to_str().unwrap(),
        )
        .unwrap();

        assert_eq!(fs::read(&decoded).unwrap(), fs::read(&new).unwrap());
        assert_eq!(fs::read(&patched).unwrap(), fs::read(&new).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_decompression_removes_partial_output() {
        let root = test_root("decompress-limit");
        let source = root.join("source");
        let compressed = root.join("source.zst");
        let decoded = root.join("decoded");
        fs::write(&source, vec![b'x'; 64 * 1024]).unwrap();
        zstd_compress_file(source.to_str().unwrap(), compressed.to_str().unwrap(), 3).unwrap();

        let error = zstd_decompress_file_bounded(
            compressed.to_str().unwrap(),
            decoded.to_str().unwrap(),
            1024,
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(!decoded.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_patch_rejects_input_and_output_limits() {
        let root = test_root("patch-limit");
        let old = root.join("old");
        let new = root.join("new");
        let patch = root.join("patch");
        let patched = root.join("patched");
        fs::write(&old, b"old release").unwrap();
        fs::write(&new, vec![b'n'; 32 * 1024]).unwrap();
        bsdiff_file(
            old.to_str().unwrap(),
            new.to_str().unwrap(),
            patch.to_str().unwrap(),
        )
        .unwrap();

        let patch_len = fs::metadata(&patch).unwrap().len();
        let input_error = bspatch_file_bounded(
            old.to_str().unwrap(),
            patch.to_str().unwrap(),
            patched.to_str().unwrap(),
            1024,
            patch_len - 1,
            64 * 1024,
        )
        .unwrap_err();
        assert_eq!(input_error.kind(), io::ErrorKind::InvalidData);
        assert!(!patched.exists());

        let output_error = bspatch_file_bounded(
            old.to_str().unwrap(),
            patch.to_str().unwrap(),
            patched.to_str().unwrap(),
            1024,
            patch_len,
            1024,
        )
        .unwrap_err();
        assert_eq!(output_error.kind(), io::ErrorKind::InvalidData);
        assert!(!patched.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_writer_preserves_limits_above_u32() {
        let limit = 8_u64 * 1024 * 1024 * 1024;
        let mut output = BoundedWriter::new(Vec::new(), limit);
        output.write_all(b"mirin").unwrap();
        assert_eq!(output.remaining, limit - 5);
        assert_eq!(output.inner, b"mirin");
    }

    #[test]
    fn bounded_patch_rejects_the_combined_memory_budget() {
        let mib = 1024 * 1024;
        let error =
            validate_patch_input_lengths(400 * mib, 200 * mib, u64::MAX, u64::MAX, 512 * mib)
                .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
