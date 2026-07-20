//! The core FFI and release helper share one codec implementation.

pub use mirin_codec::{
    bsdiff_file, bspatch_file, bspatch_file_bounded, zstd_compress_file, zstd_decompress_file,
    zstd_decompress_file_bounded,
};
