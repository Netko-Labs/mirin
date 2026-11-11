# CLAUDE.md - mirin

Mirin is a Bun-native desktop app framework with a Rust native core and CEF as
the rendering engine. This file applies to the whole repository unless a deeper
entry file overrides it.

Keep `CLAUDE.md` and `AGENTS.md` equivalent. If one changes, update the other in
the same change.

## Project Overview

- Runtime and package manager: Bun.
- Native core: Rust (`crates/mirin-core`) compiled as `libmirin_core`.
- Renderer/runtime: CEF, with a Bun Worker owning user main-process code.
- Metal (alpha): the CEF-free flavor; React rendered as GPU UI through GPUI
  (`crates/mirin-metal`, `@mirinjs/metal`, `@mirinjs/metal-ui`). See
  `docs/metal.md`.
- CLI: `@mirinjs/cli` drives `mirin dev`, `mirin check`, `mirin doctor`,
  `mirin build`, `mirin release`, `mirin init`, and `mirin skill`.
- Reference: electrobun is useful for proven approaches, but do not copy from it
  wholesale without calling out the source and adapting the design to mirin.

## Source Of Truth

- `docs/architecture.md` - process model, threading, FFI, IPC, CEF lifecycle.
  Keep code and this doc in sync in the same change.
- `docs/api-design.md` - developer-facing API. The owner signs off on public API
  changes.
- `docs/macos-mvp.md`, `docs/windows-port.md`, and `docs/linux-port.md` -
  milestone status, platform findings, and known gaps.
- `docs/metal.md` - Metal, the CEF-free flavor: element-tree protocol, process
  model decisions, platform findings, and milestone status.
- `docs/agent-devtools.md` - the development observability surface: the structured
  event stream, `.mirin/dev/` session artifacts, the loopback inspector, the
  DevTools-protocol bridge, `mirin check` scenarios, `mirin check` / `mirin doctor`,
  and the installable agent skill (`mirin skill`).
- `docs/conventions.md` - shared code-style, structure, safety, and verification
  rules.

The shared code-style and structure rules live in:

@docs/conventions.md

Keep `CLAUDE.md` and `AGENTS.md` equivalent. If one changes, update the other in
the same change.

## Hard Constraints

- The main process runtime is Bun. Do not add Node compatibility shims to mirin's
  own runtime code.
- macOS and Linux render with CEF. Windows currently uses CEF and may grow a
  WebView2 backend behind an abstraction. Metal is a separate app flavor
  (GPUI), never a mode of a CEF window, and may not break or shadow the shared
  `mirinjs` surface (`docs/metal.md` section 0).
- All AppKit, Win32 UI, Xlib window, and CEF browser-process UI calls happen on
  the main/UI thread. Worker-originated commands post UI tasks through the Rust
  engine.
- FFI crosses a flat C ABI on `libmirin_core`; options and events are JSON
  envelopes for v1.
- `ffi.rs` stays thin. Business logic belongs in `engine/` or platform modules.
- Update docs with behavior changes, especially around architecture, public API,
  packaging, updater behavior, or platform lifecycle.

## Repository Layout

- `crates/mirin-core` - Rust native core (`cdylib` plus test/smoke binaries).
- `crates/mirin-helper` - CEF subprocess executable.
- `crates/mirin-metal` - Metal renderer: GPUI-rendered native UI, no CEF (alpha;
  standalone, excluded from the Cargo workspace). See `docs/metal.md`.
- `packages/mirin` - developer-facing runtime, RPC, client bridge, updater, and
  typed app APIs.
- `packages/mirin-cli` - dev/build/release/init tooling.
- `packages/create-mirin` - project scaffold package.
- `packages/mirin-metal` - `@mirinjs/metal`, the React renderer for Metal (write
  normal JSX, rendered as GPU UI through `crates/mirin-metal`).
- `packages/mirin-metal-ui` - `@mirinjs/metal-ui`, shadcn/ui ported 1:1 onto
  Metal (same component names, props, variants, theme tokens; `className`
  strings translated from Tailwind).
- `packages/native-*` - prebuilt native packages.
- `examples/*` - real apps used for behavior checks and feature demos.
- `docs/*` - architecture, API, platform, getting-started, and convention docs.
- `vendor/cef/` - fetched CEF distribution; never committed.

## Commands

- Install dependencies: `bun install`
- Verify an app starts non-interactively: `cd examples/hello-react && bunx mirin check`
  (boots once, captures a screenshot + UI snapshot, exits non-zero on renderer errors)
- Verify a user flow still works: `bunx mirin check --scenario ./check.ts` (drives the
  real UI and asserts; `examples/hello-react/check.ts` is the worked example)
- Diagnose a project/environment without building: `mirin doctor` (`--json` for a
  parseable report)
- Install the agent skill into a project: `mirin skill` (assets live in
  `packages/create-mirin/skill/`; `mirin init` installs it for new apps)
- TypeScript lint/format check: `bun run fmt-lint`
- TypeScript lint/format fix: `bun run fmt-lint:fix`
- TypeScript typecheck: `bun run typecheck`
- TypeScript/unit tests: `bun run test`
- Rust check: `bun run check:rust`
- Rust build: `cargo build --workspace`
- Rust clippy: `cargo clippy --workspace --all-targets -- -D warnings`
- Rust format check: `cargo fmt --all --check`
- Fetch CEF: `bun scripts/fetch-cef.ts`
- Run an example app: `cd examples/hello-react && bun run dev`
- Build a feature-heavy example: `cd examples/kitchen-sink && bun run build`
- Metal crate (outside the workspace), from `crates/mirin-metal`: `cargo fmt
  --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and
  `cargo build --release --bin mirin-metal-host` for the host
- Metal UI tests alone: `cd packages/mirin-metal-ui && bun test`

## Verification

- Start with the smallest relevant check for the files changed, then broaden
  when shared contracts, platform behavior, or public APIs are affected.
- Docs-only changes should at least run `git diff --check`.
- TypeScript changes should run `bun run fmt-lint`, `bun run typecheck`, and
  relevant `bun run test` coverage.
- Rust changes should run `cargo fmt --all --check`, `cargo clippy --workspace
  --all-targets -- -D warnings`, and the relevant build/test command.
- Native behavior should be verified with a real app (`mirin dev` or a built app)
  whenever practical. `mirin check` does this non-interactively and exits non-zero
  on renderer errors; the run's structured stream lands in
  `.mirin/dev/<session>/events.jsonl` (docs/agent-devtools.md).
- If a command cannot be run, record the reason and the remaining risk in the
  handoff.

## Git Rules

- Branch off the default branch before committing.
- Commit freely at logical checkpoints. Push or open a PR only when asked.
- Never force-push, amend, rebase, squash, reset, or discard shared/user changes
  unless explicitly requested.
- The working tree may be dirty. Preserve unrelated changes and work with them.
- Do not drop stashes or generated backups unless explicitly asked.
