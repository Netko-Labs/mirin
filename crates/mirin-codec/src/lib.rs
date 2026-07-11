//! Updater codec shared by the app runtime and the standalone release helper.

use qbsdiff::{Bsdiff, Bspatch};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::thread;

fn read_all(path: &str) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    File::open(path)?.read_to_end(&mut buf)?;
    Ok(buf)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn compression_and_patch_round_trip() {
        let root = std::env::temp_dir().join(format!(
            "mirin-codec-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
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
}
