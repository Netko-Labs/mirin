//! The core FFI and release helper share one codec implementation.

pub use mirin_codec::{bsdiff_file, bspatch_file, zstd_compress_file, zstd_decompress_file};
