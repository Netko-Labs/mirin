# mirin — development notes

Mirin is a Bun-native desktop app framework (Electron-like) with a Rust core and CEF as the rendering engine. Clean rewrite informed by electrobun (cloned read-only at `electrobun-reference/`, gitignored — consult it for proven solutions, never copy wholesale without noting it).

## Source of truth
- `docs/architecture.md` — process model, threading, FFI, IPC. Keep code and this doc in sync in the same change.
- `docs/api-design.md` — developer-facing API. Draft status; owner signs off on changes to it.
- `docs/macos-mvp.md` — milestone plan and risk register.

## Hard constraints
- The main process runtime is **Bun**, always. No Node compatibility shims in mirin's own code.
- macOS/Linux render with **CEF only**. Windows defaults to CEF with WebView2 as opt-in (engine abstraction is a Rust trait from day one).
- All AppKit/CEF browser-process UI calls happen on the main thread (owned by Rust after `mirin_run`). User code runs in a Bun Worker.
- FFI crosses a flat C ABI on `libmirin_core`; options/events are JSON envelopes (v1).

## Layout
- `crates/mirin-core` (cdylib), `crates/mirin-helper` (CEF subprocesses) — Cargo workspace.
- `packages/mirin` (runtime + rpc + client), `packages/mirin-cli` — Bun workspace.
- `vendor/cef/` is fetched, never committed.
