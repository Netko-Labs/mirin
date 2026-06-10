# Contributing to mirin

Thanks for helping build a Bun-native desktop framework. Read `AGENTS.md` for
the code conventions (they apply to humans and agents alike).

## Dev setup (the monorepo)

Requirements: Bun ≥ 1.2, the Rust toolchain ≥ 1.91, `cmake` + `ninja`
(`brew install cmake ninja`), and the Xcode command-line tools. macOS arm64.

```bash
git clone git@github.com:Netko-Labs/mirin.git
cd mirin
bun install
bun scripts/fetch-cef.ts     # one-time: download the pinned CEF (~hundreds of MB)
cargo build --workspace      # builds the Rust core + helper
bun run typecheck
```

Run an example (the CLI builds the native crates from source when run in-repo):

```bash
cd examples/hello-react
bun ../../packages/mirin-cli/src/index.ts dev
```

`examples/kitchen-sink` exercises every native feature; `examples/spotlight` is a
hotkey-summoned frameless panel.

## Layout

```
crates/
  mirin-core/    cdylib: ffi.rs (C ABI), engine/*, mac/*, scheme.rs
  mirin-helper/  CEF subprocess (preload injection)
packages/
  mirin/             runtime API (apps import this)        → npm: mirin
  mirin-cli/         the `mirin` CLI (dev/build/init)       → npm: @mirin/cli
  native-darwin-arm64/  prebuilt binaries (CI-populated)    → npm: @mirin/darwin-arm64
  create-mirin/      scaffolder + template                 → npm: create-mirin
examples/            hello-react, kitchen-sink, spotlight
docs/                architecture, api-design, macos-mvp, getting-started
```

## Conventions

- **Rust:** `cargo build --workspace` and `cargo fmt --all --check` must pass, zero warnings. One concern per module; `ffi.rs` stays thin.
- **TypeScript:** `bun run typecheck` must pass. No `any`; precise return types.
- **Behavior:** prefer running the real app and observing over isolated assertions. See `AGENTS.md`.
- **Architecture/IPC/threading invariants:** `docs/architecture.md`. Keep code and docs in sync in the same change.

## Pull requests

Branch off `main`. Don't force-push a branch with an open PR. CI runs the build +
typecheck + fmt on macOS arm64.
