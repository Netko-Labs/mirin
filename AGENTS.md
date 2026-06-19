# AGENTS.md — mirin

Conventions for working in this repo (humans and coding agents). Adapted from
[TanStack's AGENTS.md guidance](https://github.com/TanStack/db/blob/main/AGENTS.md).
`CLAUDE.md` has the high-level project orientation; this file is the code rules.

## Source of truth

- `docs/architecture.md` — process model, threading, FFI, IPC. Keep code and this in sync in the same change.
- `docs/api-design.md` — developer-facing API (owner signs off on changes).
- `docs/macos-mvp.md` — milestone status and findings. Update when a milestone lands.
- Memory files (CEF close lifecycle, MVP architecture, app:// findings) capture hard-won, non-obvious facts — read before re-deriving.

## TypeScript

- **Types**: no `any`. Use `unknown` + type guards when a type is genuinely unknown. Always give functions the most precise return type. Be explicit about optionality — if a field is optional, it should truly be.
- **Structure**: `src/` ships only production code; the package's public surface is its `exports` map. Keep modules small and focused; one concern per file (`menu.ts`, `tray.ts`, …). Extract shared logic into helpers rather than duplicating.
- **Naming**: describe role/purpose, not data structure (no Hungarian). Names should read like prose. Match patterns already used in the codebase.
- **Idioms**: prefer `??` / `??=`, spread, and `.map/.filter/.reduce` over manual loops. Prefer positive predicates over negated ones. Use `Set`/`Map` for lookups.
- **Encapsulation**: don't expose internal structures across module boundaries. `@internal` members on public classes are wired only from the runtime.
- **Async**: account for out-of-order resolution; correlate requests/responses by id.

## Rust (mirin-core / mirin-helper)

- One concern per module: `engine/{boot,events,window,handlers,tasks,commands}.rs`, `mac/{app,window,menu,tray,dialog,clipboard,shortcut,util}.rs`, `scheme.rs`, `ffi.rs`.
- **Platform split.** `win/` mirrors `mac/` one-concern-per-module (`window`, `menu`, `tray`, `dialog`, `clipboard`, `shortcut`) using `windows-sys` (raw, matches cef's HWND base type — convert to cef's `cef::sys::HWND` newtype only at the `set_as_child`/`window_handle` boundary). `engine/` submodules dispatch with `#[cfg(target_os = "macos")]` / `#[cfg(target_os = "windows")]` arms; keep a `#[cfg(not(any(...)))]` fallback so the build stays green on unported targets. Windows is CEF-windowed (child HWND), not OSR — see `docs/architecture.md` §8 for the close handshake and custom-title-bar dragging.
- **`ffi.rs`** holds the entire `#[no_mangle] extern "C"` surface. FFI functions are thin: parse the C input, call an `engine::` function, return. No business logic in the ABI layer.
- All AppKit / CEF-UI calls run on the **main (UI) thread**. Commands from the Worker thread post a CEF task (`engine::tasks`) to the UI thread. Never hold the `MirinHandler` mutex across `close_browser` (re-enters `on_before_close`).
- Events to the Worker go through `engine::events` (the polled queue), never a bun:ffi callback.
- Keep `unsafe` blocks minimal and commented with the invariant they rely on.
- Custom-scheme options and any cross-process registration (e.g. `app://`) must be identical in every process that registers them.

## Feature pattern (adding a native capability)

1. `mac/<feature>.rs` — the AppKit implementation, main-thread only.
2. `engine/commands.rs` (or a feature module) — a safe function the Worker calls; posts a UI task if needed.
3. `ffi.rs` — the `mirin_*` C entry point(s).
4. `packages/mirin/src/<feature>.ts` — the typed developer API; wire it into `app` in `app.ts`.
5. `packages/mirin/src/native.ts` — add the FFI binding.
6. Events (clicks, triggers, results) flow back via the event queue → `runtime.ts` dispatch.
7. Add a section to `examples/kitchen-sink` demonstrating it.

## Verifying

- Rust: `cargo build --workspace` must be warning-clean.
- TS: `bun run typecheck` must pass.
- Behavior: prefer running the real app (`mirin dev` / a built `.app`) and observing, over asserting in isolation. Reproduce a bug with a test before fixing it.

## Git

- Branch off the default branch before committing; commit/push only when asked.
- Never force-push, amend, rebase, or squash a pushed/PR branch — treat its history as shared.
