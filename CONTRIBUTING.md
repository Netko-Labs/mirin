# Contributing To Mirin

Thanks for helping build a Bun-native desktop framework. Read `AGENTS.md` and
`docs/conventions.md` before changing code; their structure, safety, and
verification rules apply to humans and agents alike.

## Development Setup

All platforms need Bun 1.3.14 or newer, the stable Rust toolchain, CMake, and
Ninja. Native prerequisites differ by host:

- macOS arm64: Xcode command-line tools.
- Windows x64: Visual Studio Build Tools with the MSVC C++ toolchain.
- Linux x64: GTK 3 development headers (`libgtk-3-dev` on Ubuntu).

```bash
git clone git@github.com:Netko-Labs/mirin.git
cd mirin
bun install
bun scripts/fetch-cef.ts
cargo build --workspace
```

CEF is pinned by the Rust dependency and downloaded into the ignored
`vendor/cef/` directory. Consumer apps use matching prebuilt native packages and
cache CEF under `~/.mirinjs/cef/`; they do not need a Rust toolchain.

## Repository Layout

```txt
crates/
  mirin-core/              C ABI, engine orchestration, and native platforms
  mirin-helper/            CEF subprocess and renderer preload injection
packages/
  mirin/                   public runtime package (`mirinjs`)
  mirin-cli/               dev, build, release, and init tooling
  create-mirin/            project scaffolder (`create-mirinjs`)
  native-darwin-arm64/     prebuilt macOS core and helper
  native-win32-x64/        prebuilt Windows core and helper
  native-linux-x64/        prebuilt Linux core and helper
examples/
  hello-react/             smallest application loop
  kitchen-sink/            broad native feature coverage
  spotlight/               frameless global-shortcut panel
  liquid-glass/            macOS material behavior
  updater/                 release and updater flow
docs/                      architecture, API, platform, and convention docs
```

The detailed TypeScript and Rust folder rules live in
`docs/conventions.md`. Keep `ffi.rs` thin, keep UI work on the UI thread through
`engine::tasks`, and preserve package public surfaces through their exports.

## Running An Example

The CLI recognizes the monorepo, builds native crates from source, and uses the
local CEF checkout:

```bash
cd examples/hello-react
bun run dev
```

Use `examples/kitchen-sink` for broad behavior checks and `examples/updater` for
a complete local release artifact smoke test.

## Verification

Start with the smallest relevant check, then run the full gates before opening a
pull request:

```bash
bun run fmt-lint:ci
bun run typecheck
bun run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
git diff --check
```

For native behavior, run or release a real example on the affected platform.
The CI matrix repeats native build and Clippy checks on Blacksmith macOS arm64,
Windows x64, and Linux x64 runners.

## Pull Requests

Branch from `main` and keep unrelated worktree changes intact. Update docs in the
same change when architecture, public API, packaging, updater, or platform
lifecycle behavior changes. Do not force-push, rewrite shared history, or publish
packages unless the repository owner explicitly requests it.
