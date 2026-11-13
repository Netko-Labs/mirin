//! Where mirin's fork of gpui 0.2.2 (`forks/gpui`, the default build) and
//! upstream GPUI (`forks/zed`, built by `next/Cargo.toml` with the `gpui-next`
//! feature) differ in shape: one item per difference, with the same signature
//! on both sides, so the rest of the crate has no `cfg` for them. What
//! upstream lacks altogether is ported into `forks/zed` with the fork's API
//! (`forks/zed/MIRIN.md`) rather than wrapped here; what is not ported yet is
//! a stand-in in `upstream.rs`, marked `GAP`. See docs/metal/gpui-next.md.

#[cfg(not(feature = "gpui-next"))]
mod fork;
#[cfg(not(feature = "gpui-next"))]
pub(crate) use fork::*;

#[cfg(feature = "gpui-next")]
mod upstream;
#[cfg(feature = "gpui-next")]
pub(crate) use upstream::*;
