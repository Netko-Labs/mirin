#!/bin/sh
# Fetch the upstream GPUI crates the spike builds against: a shallow, sparse
# checkout of the zed repository at one pinned commit, into ./zed (ignored by
# git). Upstream's sources are referenced, never copied into mirin.
#
#   ./fetch-zed.sh [destination]     (default: ./zed, where Cargo.toml expects it)
set -eu

REV=f8cfc7ed9e57503def9479138894f3139f5400cc # zed main, 2026-11-10
DEST=${1:-"$(dirname "$0")/zed"}

if [ ! -d "$DEST/.git" ]; then
    git init -q "$DEST"
    git -C "$DEST" remote add origin https://github.com/zed-industries/zed
fi
# GPUI's crates, the workspace crates they depend on (on any target: cargo
# reads every dependency's manifest to resolve), and the workspace root their
# `workspace = true` fields inherit from.
git -C "$DEST" sparse-checkout set --no-cone \
    '/crates/gpui*' \
    /crates/bench_metrics \
    /crates/collections \
    /crates/http_client \
    /crates/refineable \
    /crates/scheduler \
    /crates/sum_tree \
    /crates/ztracing \
    /crates/ztracing_macro \
    /Cargo.toml \
    /Cargo.lock \
    /LICENSE-APACHE \
    /LICENSE-GPL \
    /rust-toolchain.toml
git -C "$DEST" fetch -q --depth 1 --filter=blob:none origin "$REV"
git -C "$DEST" checkout -q --detach FETCH_HEAD
echo "zed at $(git -C "$DEST" rev-parse --short HEAD) in $DEST"
