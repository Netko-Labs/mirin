use mirin_codec::{
    atomic_swap_directories, bsdiff_file, bspatch_file, bspatch_file_bounded,
    durable_move_directory, durable_remove_directory, durable_remove_file, durable_write,
    process_token, sync_parent, sync_tree, terminate_process, validate_atomic_swap_directories,
    wait_for_process_exit, zstd_compress_file, zstd_decompress_file, zstd_decompress_file_bounded,
};
use std::env;
use std::io;
use std::path::Path;
use std::time::Duration;

fn argument<'a>(args: &'a [String], index: usize, usage: &str) -> io::Result<&'a str> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, usage))
}

fn byte_limit(value: &str) -> io::Result<u64> {
    value
        .parse::<u64>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid byte limit"))
}

fn process_id(value: &str) -> io::Result<u32> {
    value
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid process id"))
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
        "decompress-bounded" => zstd_decompress_file_bounded(
            argument(&args, 1, "missing source path")?,
            argument(&args, 2, "missing destination path")?,
            byte_limit(argument(&args, 3, "missing output byte limit")?)?,
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
        "patch-bounded" => bspatch_file_bounded(
            argument(&args, 1, "missing old path")?,
            argument(&args, 2, "missing patch path")?,
            argument(&args, 3, "missing new path")?,
            byte_limit(argument(&args, 4, "missing old input byte limit")?)?,
            byte_limit(argument(&args, 5, "missing patch input byte limit")?)?,
            byte_limit(argument(&args, 6, "missing output byte limit")?)?,
        ),
        "atomic-swap" => atomic_swap_directories(
            Path::new(argument(&args, 1, "missing first directory")?),
            Path::new(argument(&args, 2, "missing second directory")?),
        ),
        "validate-swap" => validate_atomic_swap_directories(
            Path::new(argument(&args, 1, "missing first directory")?),
            Path::new(argument(&args, 2, "missing second directory")?),
        ),
        "sync-tree" => sync_tree(Path::new(argument(&args, 1, "missing tree path")?)),
        "sync-parent" => sync_parent(Path::new(argument(&args, 1, "missing child path")?)),
        "durable-write" => durable_write(
            Path::new(argument(&args, 1, "missing destination path")?),
            argument(&args, 2, "missing durable contents")?.as_bytes(),
        ),
        "durable-move" => durable_move_directory(
            Path::new(argument(&args, 1, "missing source directory")?),
            Path::new(argument(&args, 2, "missing destination directory")?),
        ),
        "durable-remove-directory" => {
            durable_remove_directory(Path::new(argument(&args, 1, "missing directory path")?))
        }
        "durable-remove-file" => {
            durable_remove_file(Path::new(argument(&args, 1, "missing file path")?))
        }
        "process-token" => {
            println!(
                "{}",
                process_token(process_id(argument(&args, 1, "missing process id")?)?)?
            );
            Ok(())
        }
        "wait-process" => wait_for_process_exit(
            process_id(argument(&args, 1, "missing process id")?)?,
            argument(&args, 2, "missing process token")?,
            Duration::from_millis(byte_limit(argument(
                &args,
                3,
                "missing process wait timeout",
            )?)?),
        ),
        "terminate-process" => terminate_process(
            process_id(argument(&args, 1, "missing process id")?)?,
            argument(&args, 2, "missing process token")?,
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
