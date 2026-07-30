# Handoff: agent devtools

Status: **code complete, native path unverified.** Everything TypeScript is verified;
nothing was ever compiled as Rust or run as a real app.

Read `docs/agent-devtools.md` first — it is the source of truth for the surface.
This file is only the handoff: what to verify, in what order, and what to do when a
step fails.

## Why this exists

The branch was written in a container where `mirin-core` **cannot compile**:
`cef-builds.spotifycdn.com` returns 403 through the sandbox proxy, so
`cef-dll-sys`'s build script cannot download the CEF distribution and `cargo check`
fails before touching mirin's own code. No CEF also means no window, so no command
that boots the app was ever exercised.

The Rust surface was kept deliberately tiny for exactly this reason — 94 lines
across 4 files, no new FFI symbols.

CI has since covered the compile half (Step 1). What remains is the half no CI job
can reach: **actually looking at a running app.** Every capability this branch adds
is about seeing and driving a window, and none of it has been pointed at a real one.

## Branch

`claude/mirin-ai-observability-0s84bh`, 5 commits ahead of `main`:

```
11b4adb  fix: keep the devtools stream readable and non-blocking
d19c9c4  feat: mirin check and doctor, --json output, and agent devtools docs
4112890  feat: DevTools-protocol bridge for screenshots, snapshots, and input
75575fb  feat: loopback inspector for the devtools stream
d8c6a5e  feat: structured devtools event stream for agents
```

## What is and is not verified

| Check | State |
| --- | --- |
| `bun run test` (131 tests) | ✅ pass |
| `bun run typecheck` | ✅ pass |
| `bun run fmt-lint` | ✅ pass (57 warnings, all pre-existing) |
| `cargo fmt --all --check` | ✅ pass |
| `mirin doctor`, both outcomes | ✅ ran for real |
| `cargo clippy` / `cargo build` | ✅ **by CI** — see Step 1 |
| `cargo test --workspace` | ✅ by CI |
| `mirin dev` (any platform) | ❌ never ran |
| `mirin check` | ❌ never ran |
| Screenshot / snapshot / eval / act | ❌ never ran |
| Packaged build has devtools off | ❌ never ran |

Mutation-tested (deliberately broke the code, confirmed the tests fail): selector
injection, click event pairing, the JSON-serializability guard.

---

## Step 1 — compile gate (CI owns this)

**Do not duplicate this locally unless CI is red.** `.github/workflows/ci.yml`'s
`Native checks` job fetches CEF and runs exactly the gate the authoring environment
could not:

```sh
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

…on macOS arm64, Linux x64, Linux arm64, Windows x64, and Windows arm64. On the
first run of this branch (`06859b4`) macOS arm64 and Linux x64 came back green,
which is what closed the compile risk; check the PR for the current run's full
matrix.

So the local machine's job is **Step 2** — the real-app verification CI cannot do,
because CI has no display and never opens a window.

If CI *is* red on a native job, the whole Rust diff is 4 files; read it in one go
with `git diff main..HEAD -- crates/`.

| File | Change |
| --- | --- |
| `engine/config.rs` | `remote_debugging_port: u16` on `CoreConfig` + `debug_port() -> i32` (0 or ≥1024) |
| `engine/boot.rs` | passes `config.debug_port()` into CEF's `Settings` |
| `engine/handlers/display.rs` | console output → structured `webview.console` event; `clamp` at 4000 chars; `level_name` maps `LogSeverity` |
| `engine/handlers/mod.rs` | `MirinHandler::window_id_for_ident(i32) -> Option<u32>`, using `try_lock` |

Signatures were read out of the vendored `cef-148.4.0+148.0.10` bindings rather than
guessed, so these should hold — but confirm if the build breaks:

- `Settings.remote_debugging_port` is `c_int`; `debug_port()` returns `i32`. ✔
- `LogSeverity` derives `PartialEq`, so `level == LogSeverity::ERROR` is valid. If a
  future CEF bump drops that derive, compare `level.get_raw()` instead.
- `ImplBrowser::identifier(&self) -> c_int`, matching the `i32` parameter. (Note
  `ImplRequest::identifier` returns `u64` — do not confuse them.)
- `use crate::engine::events::emit_event;` in `display.rs` mirrors its sibling
  `app.rs` line 9, so the module path is fine.
- `serde_json::json!` is used rather than string interpolation because the message
  is page-controlled. **Keep it that way** if you touch that block.

Likely clippy nits, if any: `clamp` shares a name with `Ord::clamp` (free function,
no conflict), and `level_name` is an if/else chain because `LogSeverity` is a newtype
and not `match`-able.

---

## Step 2 — real-app verification

Do these in order; each builds on the last. Acceptance criteria are stated so a
result can be judged without re-reading the design.

Helper for the steps below:

```sh
cd examples/kitchen-sink            # more surface than hello-react
SESSION=$(bun -e 'console.log(JSON.parse(await Bun.file(".mirin/dev/current.json").text()).session)')
PORT=$(bun -e 'console.log(JSON.parse(await Bun.file(process.env.S+"/inspector.json").text()).port)')
TOKEN=$(bun -e 'console.log(JSON.parse(await Bun.file(process.env.S+"/inspector.json").text()).token)')
# (export S="$SESSION" before the last two)
```

### 2a — `mirin dev` still works, and records itself

```sh
bun run dev
```

- [ ] The window opens and the UI works exactly as before this branch.
- [ ] The terminal prints `dev session: …/.mirin/dev/<id>` and, a moment later,
      `inspector: http://127.0.0.1:<port>`.
- [ ] `.mirin/dev/<id>/` contains `session.json`, `inspector.json`, `events.jsonl`,
      and an empty `screenshots/`.
- [ ] `session.json` `phases` shows `compile`/`bundle`/`vite`/`launch`, each
      `start` then `ok`.
- [ ] `events.jsonl` has `src:"native"` window events, `src:"main"` logs, and — after
      clicking around — `src:"rpc"` request/response pairs with `ms` timings.
- [ ] A `console.log("hi")` in the UI appears as
      `{"src":"renderer","type":"console","msg":"hi","window":<n>}`. **`window` must
      not be null** — that is `window_id_for_ident` working.
- [ ] Ctrl-C, then confirm `exit.json` exists with a `code` and a `tail`.

**If `window` is null on every console event:** `try_lock` is losing the race, or the
browser identifier is not in `window_ids` yet. Not fatal (attribution is best-effort)
but worth a note in the PR.

### 2b — CEF actually opened its debugging port

With `mirin dev` running:

```sh
curl -s http://127.0.0.1:$(bun -e 'console.log(JSON.parse(await Bun.file(process.env.S+"/inspector.json").text()).cdpPort)')/json/list | head -20
```

- [ ] Returns a JSON array containing a `"type":"page"` target with a
      `webSocketDebuggerUrl`.
- [ ] `events.jsonl` contains `devtools.cdp-attached` (not `devtools.cdp-unavailable`).

**If unavailable:** the port never reached CEF. Check `MIRIN_CDP_PORT` in the app's
environment, then that `mirin_run`'s config JSON carries `remote_debugging_port`
(add a temporary `eprintln!` in `run_core`). This is the single most likely place for
the native change to be wrong.

### 2c — the inspector answers

```sh
curl -s "http://127.0.0.1:$PORT/?token=$TOKEN"                    # route index
curl -s "http://127.0.0.1:$PORT/state?token=$TOKEN"
curl -s "http://127.0.0.1:$PORT/logs?level=error&token=$TOKEN"
curl -sN "http://127.0.0.1:$PORT/logs/stream?token=$TOKEN" | head -5
```

- [ ] `/state` lists the open window with a real `url`, `title`, and non-zero
      `frame`, plus the app's RPC routes under `rpc.routes`.
- [ ] `/logs/stream` emits `: mirin inspector stream` immediately, then frames.
- [ ] No token → 401. Wrong token → 401.
- [ ] `curl -s -H 'Host: evil.example' "http://127.0.0.1:$PORT/state?token=$TOKEN"`
      → **403**. This is the DNS-rebinding guard; it must not pass.

### 2d — screenshot, snapshot, eval, act

```sh
curl -s "http://127.0.0.1:$PORT/screenshot?token=$TOKEN"
curl -s "http://127.0.0.1:$PORT/snapshot?token=$TOKEN"
curl -s -X POST "http://127.0.0.1:$PORT/eval?token=$TOKEN" \
  -H 'content-type: application/json' -d '{"expression":"document.title"}'
curl -s -X POST "http://127.0.0.1:$PORT/act?token=$TOKEN" \
  -H 'content-type: application/json' -d '{"action":"click","selector":"text=<a real button label>"}'
```

- [ ] `/screenshot` returns a `path`; **open the PNG and confirm it shows the real
      UI**, not a blank or white frame. (Transparent/OSR windows are the risk here —
      test one of those too, e.g. `examples/liquid-glass`.)
- [ ] `/snapshot` returns an indented tree whose roles and names match what is
      on screen, and is far shorter than `?format=dom`.
- [ ] `/eval` returns the page title.
- [ ] `/act` click visibly does the thing a person clicking would, and the resulting
      RPC call shows up in `/logs`.
- [ ] Multi-window: open a second window, confirm `?window=<id>` targets the right
      one and that the two snapshots differ.

### 2e — `mirin check`, both outcomes

```sh
bun run check ; echo "exit=$?"
```

- [ ] Exits **0** on a healthy app, prints a screenshot path and a UI snapshot.
- [ ] Leaves no app or Vite process behind (`pgrep -f vite`, check the app).

Then break it on purpose — add `throw new Error("boom")` at the top of the UI entry:

```sh
bun run check ; echo "exit=$?"
```

- [ ] Exits **1**, and the output names the exception **with a stack trace**.
- [ ] `bun run check --json` emits only parseable JSON lines (pipe it through
      `bun -e 'for (const l of (await Bun.stdin.text()).trim().split("\n")) JSON.parse(l)'`).
- [ ] Revert the deliberate break.

This is the highest-value single test: it exercises the taps, the session files, the
inspector, the CDP bridge, and the exit-code contract in one command.

### 2f — packaged builds must expose nothing (security)

```sh
bun run build
# launch the built app from ./build directly, not through the CLI
```

- [ ] **No** `.mirin/dev/` session is created by the built app.
- [ ] **No** inspector port is listening (`lsof -iTCP -sTCP:LISTEN -P | grep -i <app>`).
- [ ] `curl http://127.0.0.1:9222/json/list` fails — CEF's debugging port is closed.
- [ ] Then set `devtools: { production: true }` in the config, rebuild, and confirm
      the inspector **does** come up — proving the gate is the only thing standing
      between a shipped app and a remote-code-execution surface. Revert afterwards.

Treat any failure in 2f as blocking.

---

## Step 3 — full suite before merging

```sh
git diff --check
bun run fmt-lint && bun run typecheck && bun run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace && cargo test --workspace
bun audit && cargo-audit audit
```

Also run `bun run dev` in `examples/hello-react` (minimal path) and
`examples/liquid-glass` (transparent/OSR window) — the OSR path is the least
certain, since screenshots of a transparent window are the case most likely to come
back empty.

## Triage

| Symptom | Look at |
| --- | --- |
| `devtools.cdp-unavailable` in the stream | `MIRIN_CDP_PORT` → `remote_debugging_port` plumbing (§2b) |
| Screenshot is blank/white | OSR/transparent window path; try `full=1`, and compare against a non-transparent window |
| `no attached webview for window N` | `webviewId` identification — the preload may not have run; check `window.mirin.webviewId` in that window's console |
| Console events have `window: null` | `window_id_for_ident` / `try_lock` (§2a) |
| `/logs` 500s | a non-serializable `data` object slipped past `encode()` in `devtools/sink.ts` — that guard exists precisely to prevent this |
| `mirin check` hangs | the launch hook never settled; `dev.ts` should always `cleanup()` in its `finally` |
| `mirin dev` prose in `--json` output | a `console.log` that should be `reporter.info` |

## Guardrails

Do not "fix" these — they are load-bearing:

- The `Host`-header check in `devtools/lib/http.ts`. Loopback binding alone is not a
  boundary; any browser on the machine can reach 127.0.0.1.
- `JSON.stringify` around selectors and CDP params in `actions.ts`. A quote in a
  selector must never become script.
- `devtools.production` defaulting to false, and individual switches being unable to
  override it (`devtools/options.ts`).
- Not forwarding `Runtime.consoleAPICalled`. The display handler already covers
  console output; forwarding both duplicates every line.
- RPC payloads staying out of the stream by default.

## Follow-ups (not in this branch)

1. **MCP server** — deliberately out of scope. It is a thin adapter over the
   inspector's HTTP surface: one tool per route, discovering `inspector.json`. This
   is the piece that makes the surface native to editors and coding agents.
2. **`--json` on `mirin release`** — only `dev`, `build`, `check`, `doctor` are wired.
3. **Console stack traces** — an uncaught error currently appears twice: as
   `console` (no stack, from CEF) and as `exception` (with stack, from CDP).
   Deduplicating them needs a correlation key.
4. **Early first-window console** — CDP attaches after CEF binds its port, so a
   `console.log` in the very first inline script can be missed by CDP. The
   display-handler tap catches it regardless, so this only affects stack traces.
5. Platform docs (`docs/macos-mvp.md`, `windows-port.md`, `linux-port.md`) have not
   been updated with devtools findings — do that once the surface is verified on
   each platform.
