//! Minimal mirin-native check: open the GPU-rendered alpha window.
//! Run from this crate's directory: `cargo run --example hello`

use mirin_native::NativeUiOptions;

fn main() {
    mirin_native::run(NativeUiOptions::default());
}
