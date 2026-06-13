//! Updater codec: zstd compression + bsdiff binary patches, file-path API.
//!
//! Pure I/O (no CEF, no main-thread requirement), so it's callable both from the
//! Bun Worker (applying an update) and from the CLI at `mirin release` time
//! (producing artifacts) through the FFI wrappers in `ffi.rs`. Using the same
//! Rust implementation on both sides guarantees byte-identical compress/diff —
//! bsdiff is sensitive to implementation differences.

use qbsdiff::{Bsdiff, Bspatch};
use std::fs::File;
use std::io::{self, BufWriter, Read};

fn read_all(path: &str) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    File::open(path)?.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Compress `src` → `dst` with zstd at `level` (e.g. 19).
pub fn zstd_compress_file(src: &str, dst: &str, level: i32) -> io::Result<()> {
    let input = File::open(src)?;
    let output = File::create(dst)?;
    zstd::stream::copy_encode(input, output, level)?;
    Ok(())
}

/// Decompress a zstd file `src` → `dst`.
pub fn zstd_decompress_file(src: &str, dst: &str) -> io::Result<()> {
    let input = File::open(src)?;
    let mut output = File::create(dst)?;
    zstd::stream::copy_decode(input, &mut output)?;
    Ok(())
}

/// Produce a bsdiff binary patch turning `old` into `new`, written to `patch`.
pub fn bsdiff_file(old: &str, new: &str, patch: &str) -> io::Result<()> {
    let old = read_all(old)?;
    let new = read_all(new)?;
    let out = BufWriter::new(File::create(patch)?);
    Bsdiff::new(&old, &new).compare(out)?;
    Ok(())
}

/// Apply a bsdiff `patch` to `old`, writing the reconstructed bytes to `new`.
pub fn bspatch_file(old: &str, patch: &str, new: &str) -> io::Result<()> {
    let old = read_all(old)?;
    let patch = read_all(patch)?;
    let out = BufWriter::new(File::create(new)?);
    Bspatch::new(&patch)?.apply(&old, out)?;
    Ok(())
}
