# Conventions

Shared code-style and structure rules for mirin. `CLAUDE.md` and `AGENTS.md`
are equivalent repository entrypoints; this file is the durable rulebook they
both reference.

## Source Of Truth

- `docs/architecture.md` owns process model, threading, FFI, IPC, CEF lifecycle,
  `app://`, platform windowing, and updater architecture. Keep it synchronized
  with behavior changes.
- `docs/api-design.md` owns developer-facing API contracts. The owner signs off
  on public API changes.
- `docs/macos-mvp.md`, `docs/windows-port.md`, and `docs/linux-port.md` record
  platform status, findings, gaps, and milestone history.
- Code is allowed to move, but source-of-truth docs must move with the behavior
  in the same change.

## Vocabulary

| Term | Meaning |
| --- | --- |
| runtime package | `packages/mirin`, the developer-facing Bun API, RPC helpers, client bridge, updater, and runtime boot. |
| CLI package | `packages/mirin-cli`, the `mirin` executable and dev/build/release tooling. |
| scaffold package | `packages/create-mirin`, the project template generator. |
| native core | `crates/mirin-core`, the Rust CEF/native library loaded through Bun FFI. |
| helper | `crates/mirin-helper`, the CEF subprocess executable. |
| engine module | Cross-platform Rust orchestration under `crates/mirin-core/src/engine/`. |
| platform module | Native implementation under `mac/`, `win/`, or `linux/`. |
| feature module | One app-shell capability such as window, menu, tray, dialog, clipboard, shortcut, sidecar, updater, or RPC. |
| module | A folder or file with a clear public surface and private implementation details. Folder modules expose that surface through `index.ts` or `mod.rs`. |
| `lib/` | A module's private implementation area. It is for helpers, parsers, adapters, hooks, and internal types used only by that module. |
| `shared/` | A package- or context-local reuse area. It is for code used by sibling modules in the same package or example, not for dumping unrelated helpers. |
| public surface | TypeScript package `exports`, the root `mirinjs` exports, `mirinjs/*` subpath exports, and the Rust C ABI in `ffi.rs`. |
| barrel/facade | An `index.ts` or `mod.rs` that declares modules and re-exports the intentional public surface. |

## Project Folder Structure

Mirin is not a web-app monorepo with domain/service layers. Its structure is a
desktop-framework workspace with runtime packages, CLI tooling, Rust native
crates, examples, and documentation. Keep those areas distinct.

Top-level layout:

```txt
crates/
  mirin-core/       Rust native core loaded through Bun FFI
  mirin-helper/     CEF subprocess executable
packages/
  mirin/            public runtime package (`mirinjs`)
  mirin-cli/        CLI package (`@mirinjs/cli`)
  create-mirin/     scaffold package
  native-*/         prebuilt platform packages
examples/
  hello-react/      minimal happy-path app
  kitchen-sink/     native feature coverage app
docs/
  architecture.md   process/threading/CEF/IPC source of truth
  api-design.md     public API source of truth
  conventions.md    this rulebook
```

Target TypeScript package layout:

```txt
packages/mirin/src/
  index.ts          package entry and public root exports
  config/           public config types and defineConfig
    index.ts        re-exports only
    manifest.ts     config surface types and defineConfig
    lib/            config-only parsing/default helpers, if needed
  app/              app singleton, windows facade, event emitters
    index.ts        re-exports only
    facade.ts       app singleton, windows facade, native event wiring
    types.ts
    lib/            private app/window/material helpers
  updater/          updater class, manifest/download/apply helpers
    index.ts        re-exports only
    types.ts
    updater.ts      updater class and singleton
    lib/            private manifest/url/archive/platform helpers
  shared/           runtime helpers reused by multiple sibling modules
```

Target CLI layout:

```txt
packages/mirin-cli/src/
  index.ts          CLI entry only
  build.ts          build orchestration
  dev.ts            dev orchestration
  release.ts        release orchestration
  bundle/           platform bundle assembly
    macos/
      index.ts
      app.ts
    windows/
      index.ts
      app.ts
    linux/
      index.ts
      app.ts
    shared/
  package/          distributable package emitters
    linux/
      index.ts
      package.ts
      lib/
  icons/            platform icon generation
    windows/
      index.ts
      icon.ts
  shared/           filesystem, shell, process, and validation helpers reused by CLI modules
```

Example apps may use `ui/lib/` for UI-private helpers and `ui/shared/` for code
reused by multiple UI modules. Keep examples small until a split improves
readability.

Rust uses named modules instead of `lib/` or `shared/`. Prefer
`state.rs`, `events.rs`, `tasks.rs`, `x11.rs`, or `registry.rs` over vague
`util.rs`/`shared.rs`.

## `lib/` And `shared/`

Use `lib/` for private implementation under the nearest module.

Rules for `lib/`:

- Only the parent module imports from its `lib/`.
- Do not export `lib/` paths through package `exports`.
- Do not import from another module's `lib/`; promote the code to `shared/` or a
  named package module if it is genuinely reused.
- `lib/` may contain internal `types.ts`, `constants.ts`, `values.ts`,
  `parsers.ts`, `platform.ts`, or a further folder when a category grows.
- `lib/` should not contain package entrypoints, CLI entrypoints, side-effectful
  boot code, or public API declarations.

Use `shared/` for reuse by sibling modules inside the same package or example.

Rules for `shared/`:

- Put code in `shared/` only after at least two sibling modules need it or the
  reuse is certain and immediate.
- Keep `shared/` organized by concern: `shared/fs`, `shared/shell`,
  `shared/events`, `shared/validation`, not one catch-all helper file.
- Shared code must still have an owner and tests when it handles paths, URLs,
  archives, shell commands, native events, or manifests.
- Cross-package reuse should graduate to an explicit package export or a small
  dedicated package; do not reach across package `src/shared` folders.

Example:

```txt
packages/mirin/src/updater/
  index.ts          exports Updater and updater singleton
  types.ts          public updater event/progress types
  lib/
    manifest.ts     private manifest parser
    urls.ts         private URL/artifact-name validation
    archive.ts      private tar layout validation
    integrity.ts    private streamed size/hash verification
    apply.ts        private platform apply scripts
```

Avoid:

```txt
packages/mirin/src/updater/
  helpers.ts        mixed URLs, manifests, shell scripts, archive parsing
```

## TypeScript

- No runtime `any`. Use `unknown` at external boundaries and narrow with a
  parser, schema, or type guard before use.
- Type-level `any` is allowed only when required for inference utilities, such as
  router/procedure type plumbing. Add a short comment explaining why it is
  type-only and why `unknown` would lose inference.
- Exported functions, public class methods, and package-surface helpers need
  explicit return types.
- Optional fields must be genuinely optional. Do not use optionality as a
  substitute for incomplete initialization.
- Prefer `??`, `??=`, object spread, `.map`, `.filter`, `.reduce`, `Set`, and
  `Map` over manual sentinel logic and lookup loops.
- Prefer positive predicates (`isReady`, `hasWindow`, `canUpdate`) over negated
  names.
- Use structured parsers for JSON, manifests, config, archive listings, and
  native events. Avoid ad hoc string manipulation when a typed helper is
  reasonable.
- Account for out-of-order async resolution. Request/response, dialog results,
  RPC calls, and updater steps must correlate by id or explicit state.

Example boundary parsing:

```ts
function parseManifest(value: unknown): Manifest {
  const object = record(value, "manifest");
  return {
    version: stringField(object, "version"),
    sha256: sha256Field(object, "sha256"),
  };
}
```

Avoid:

```ts
const manifest = (await res.json()) as any;
```

## TypeScript Modules

- `src/` contains production code only.
- Public API is the package `exports` map. Imports from `mirinjs/src/*`,
  `@mirinjs/cli/src/*`, or other deep implementation paths are unsupported.
- Keep one concern per file or folder. Examples: `menu.ts`, `tray.ts`,
  `updater/lib/urls.ts`, `updater/lib/archive.ts`, `bundle/linux/index.ts`.
- Use `index.ts` barrels when a folder has a public surface. Barrels re-export
  only; no declarations, setup work, or side effects.
- Keep internal helpers private to the module unless another module genuinely
  needs them.
- Put shared reusable helpers in a named module instead of duplicating logic.
- Avoid exposing internal runtime structures across package boundaries.
  `@internal` members on public classes are wired only from the runtime.
- CLI code should prefer structured command arguments (`$`${cmd} ${args}``) over
  shell string assembly. If shell text is unavoidable, use a dedicated quoting
  helper.

## Rust

- `ffi.rs` owns the full C ABI and stays thin: parse C input, call `engine`, and
  return ABI-safe values. No business logic belongs in the ABI layer.
- `engine/` owns cross-platform orchestration: boot, events, task posting,
  commands, CEF handlers, and platform dispatch.
- `mac/`, `win/`, and `linux/` own native platform calls. Keep OS-specific
  handles and unsafe details inside the platform module that owns them.
- Use `pub(crate)` instead of `pub` unless the symbol is intentionally public
  inside the crate facade. Prefer private helpers by default.
- `mod.rs` files should mostly declare modules and re-export intentional
  facades. Avoid putting large implementations in `mod.rs`.
- Keep platform splits explicit with `#[cfg(target_os = "...")]` arms and keep a
  `#[cfg(not(any(...)))]` fallback where unported targets must still compile.
- Use `windows-sys` for Win32. Convert to CEF handle newtypes only at the CEF
  boundary.
- Custom-scheme options and cross-process registration, especially `app://`,
  must stay identical in every process that registers them.

## Rust Folder Structure

Target `engine/` structure:

```txt
engine/
  mod.rs        declarations and re-exports only
  config.rs     serde config structs and defaults
  state.rs      process-global state, atomics, thread-local registries
  events.rs     event queue to Bun
  boot.rs       CEF startup/shutdown, cache, subprocess path, GPU flags
  commands.rs   Worker-callable command surface
  tasks.rs      UI-thread task posting
  window.rs     cross-platform window dispatch
  handlers/     CEF app/client/lifespan/display/context-menu/drag handlers
```

Target large platform-module structure:

```txt
win/window/
  mod.rs
  types.rs
  registry.rs
  identity.rs
  create.rs
  controls.rs
  wndproc.rs
  drag.rs
  dpi.rs

mac/window/
  mod.rs
  types.rs
  state.rs
  create.rs
  controls.rs
  lifecycle.rs
  drag.rs
  traffic_lights.rs

linux/window/
  mod.rs
  state.rs
  views.rs
  controls.rs
  x11.rs
  drag.rs
  icons.rs
```

Transparent macOS OSR windows are large enough to keep split separately:

```txt
mac/osr/
  mod.rs
  state.rs
  view.rs
  input.rs
  material.rs
  paint.rs
```

Facade modules that must stay declarations/re-exports plus light glue:

- `crates/mirin-core/src/engine/mod.rs`
- `crates/mirin-core/src/win/window/mod.rs`
- `crates/mirin-core/src/mac/window/mod.rs`
- `crates/mirin-core/src/linux/window/mod.rs`
- `crates/mirin-core/src/mac/osr/mod.rs`

Feature modules should mirror the platform pattern where practical:

```txt
mac/{app,window,menu,tray,dialog,clipboard,shortcut,osr}.rs
win/{window,menu,tray,dialog,clipboard,shortcut,osr,gpu}.rs
linux/{window,menu,tray,dialog,clipboard,shortcut}.rs
```

If a platform has not implemented a feature yet, keep the engine fallback small,
document the gap in the platform doc, and add a platform module when real
behavior lands.

## Rust Safety

- Keep `unsafe` blocks as small as practical and place them in the lowest-level
  platform module that can own the invariant.
- Every `unsafe` block needs a nearby `SAFETY:` comment naming the invariant it
  relies on.
- Wrap unsafe/native calls in small safe functions before exposing them to
  `engine`.
- No panics across FFI. FFI functions return neutral values, null pointers, or
  error codes.
- `expect()` is allowed only for impossible invariants and must describe the
  invariant. Prefer graceful fallback for user-, config-, OS-, or IO-controlled
  failures.
- Never expose raw registries, mutexes, or platform handles across module
  boundaries unless that module is explicitly a facade for the handle.
- Handle close/lifecycle re-entrancy carefully. In particular, never hold the
  `MirinHandler` mutex across `close_browser`.

Example:

```rust
// SAFETY: hwnd is a live top-level window created and tracked by this module.
unsafe { DestroyWindow(hwnd) };
```

## State And Threading

- AppKit, Win32 UI, Xlib window operations, and CEF UI calls run on the UI
  thread.
- Commands from the Bun Worker post a CEF task through `engine::tasks`; they do
  not call UI APIs directly.
- Events to the Worker go through `engine::events` and the polled queue, not a
  bun:ffi callback.
- Thread-local registries live in the module that owns the resource.
- Keep lock lifetimes short. Do not call into CEF or platform close/destruction
  paths while holding a handler/window registry mutex if the call can re-enter
  Rust.
- Runtime state that crosses a TS/Rust boundary should be serialized as an
  explicit JSON envelope and parsed on receipt.

## Security Boundaries

Treat these as untrusted:

- app config paths and names
- update manifests
- downloaded archives
- URLs and redirects
- environment variable overrides
- generated shell scripts
- native events and RPC frames
- data read from the filesystem, network, or subprocess stdout/stderr

Rules:

- Validate before joining paths, copying files, writing launchers, or extracting
  archives.
- Reject archive traversal before extraction.
- Keep updater artifact names flat and validate hashes before use.
- Updater network URLs must use HTTPS, except loopback HTTP for local testing.
- Prefer structured command arguments over shell strings.
- If shell text is unavoidable, quote with a dedicated helper and test the edge
  cases.
- Never add a permissive parser at a trust boundary just to make a happy path
  shorter.
- Do not log secrets, update tokens, or full local paths unless the output is
  explicitly diagnostic and user-controlled.
- Pin GitHub Actions to immutable full commit SHAs. Keep the major release in an
  inline comment so automated updates and review remain readable.

## File Size And Splitting

Target normal source files at 300 lines or less.

When a file exceeds that:

- split by concern before adding more behavior
- name the extracted module by responsibility, not by data structure
- preserve public imports through an `index.ts` or `mod.rs` facade while moving
  internals
- move tests and docs with the behavior
- document intentional exceptions only for generated code, compact protocol
  tables, or tightly coupled native glue

Line count is a smell, not a machine rule. A 320-line cohesive protocol parser is
better than five arbitrary 60-line fragments; a 600-line mixed boot/handler/task
module should be split.

## Tests

- Pure helpers need unit tests when touched: path normalization, URL validation,
  archive layout checks, manifest parsing, accelerator parsing, package metadata
  validation, and config normalization.
- Native/UI behavior should be verified with real app smokes or example builds
  instead of fake isolated tests.
- Bug fixes should add the smallest test that would have caught the bug when
  practical.
- Keep tests close to the module they exercise unless they cover a full package
  workflow.
- If a behavior is difficult to automate, record the manual reproduction and
  verification steps in the relevant doc or handoff.

## Verification

Run the relevant subset before handoff:

```sh
git diff --check
bun run fmt-lint
bun run typecheck
bun run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace
cargo test --workspace
bun audit
cargo-audit audit
```

Use real app checks for native behavior:

- `cd examples/hello-react && bun run dev` for the minimal happy path.
- `cd examples/kitchen-sink && bun run dev` for app-shell APIs.
- `cd examples/updater && bun run release` only when updater artifacts change and
  the local environment has the required signing/packaging tools.

If a check cannot be run, state why and name the residual risk.

## Workflow

- Prefer the smallest safe change that solves the problem.
- Follow existing patterns before introducing new abstractions.
- Fix root causes instead of layering on workarounds.
- Do not add dependencies unless the current stack cannot solve the problem
  cleanly.
- Keep changes scoped. Avoid drive-by refactors outside the feature or cleanup
  pass being worked.
- Update supporting artifacts when required: docs, examples, generated files,
  package metadata, release notes, or platform milestone notes.
- Use `tasks/todo.md` for non-trivial cleanup work that needs a visible
  checklist, acceptance criteria, and checkpoint notes.
- Use `tasks/lessons.md` for failure modes and prevention rules after repeated
  corrections.
- Do not create task files for one-line fixes.
- When asked to commit, use a clear conventional subject. Suggested types:
  `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`,
  `ci`, `security`.
