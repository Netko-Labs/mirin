use mirin_codec::{bsdiff_file, bspatch_file, zstd_compress_file, zstd_decompress_file};
use std::env;
use std::io;

fn argument<'a>(args: &'a [String], index: usize, usage: &str) -> io::Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, usage))
}

fn run() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let operation = argument(&args, 0, "missing codec operation")?;
    match operation {
        "compress" => {
            let level = argument(&args, 3, "usage: mirin-codec compress <src> <dst> <level>")?
                .parse::<i32>()
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid compression level")
                })?;
            zstd_compress_file(
                argument(&args, 1, "missing source path")?,
                argument(&args, 2, "missing destination path")?,
                level,
            )
        }
        "decompress" => zstd_decompress_file(
            argument(&args, 1, "missing source path")?,
            argument(&args, 2, "missing destination path")?,
        ),
        "diff" => bsdiff_file(
            argument(&args, 1, "missing old path")?,
            argument(&args, 2, "missing new path")?,
            argument(&args, 3, "missing patch path")?,
        ),
        "patch" => bspatch_file(
            argument(&args, 1, "missing old path")?,
            argument(&args, 2, "missing patch path")?,
            argument(&args, 3, "missing new path")?,
        ),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unknown codec operation: {operation}"),
        )),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("mirin-codec: {error}");
        std::process::exit(1);
    }
}
