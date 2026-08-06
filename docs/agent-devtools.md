# Agent Devtools

Source of truth for mirin's observability surface: the structured event stream, the
loopback inspector, the DevTools-protocol bridge, and the CLI commands built on
them. Keep this doc synchronized with behavior in the same change.

## Why

A running mirin app produces plenty of signal. Until this surface existed, all of
it was write-only:

| Signal | Where it passed through | What happened to it |
| --- | --- | --- |
| Renderer console | `engine/handlers/display.rs` | `eprintln!` to stderr, unstructured |
| Main-process logs | `logger` | `console.log` only |
| Every RPC call | `RpcServer.#onMessage` | not recorded |
| Every native event | `runtime.dispatch` | dropped unless a feature subscribed |
| App exit | `mirin dev` | exit code, no explanation |
| What the window shows | — | no capability at all |

So a tool working on a mirin app — an agent, a script, a CI job, an editor — could
change code and start the app, then had no way to find out what the app did. That
is the gap this fills. Everything here is a **development** surface: fully enabled
under `mirin dev`, fully disabled in a packaged build unless explicitly opted in.

## Three ways in

Deliberately layered, so a consumer can use whichever it can reach:

1. **Files** under `.mirin/dev/` — needs nothing but a filesystem.
2. **Loopback HTTP + SSE** — the inspector, for live queries and control.
3. **`--json` on CLI commands** — parseable outcomes without scraping prose.

## The event envelope

One shape carries every signal:

```jsonc
{
  "seq": 1421,              // monotonic within a session; the cursor for /logs?since=
  "ts": 1785000000000,      // epoch ms
  "src": "renderer",        // main | renderer | native | rpc | app
  "level": "error",         // debug | info | warn | error
  "type": "exception",      // dotted discriminator
  "msg": "TypeError: …",
  "window": 3,              // when the event belongs to a window
  "data": { "stack": ["…"] } // type-specific detail
}
```

Sources and the types each produces:

| `src` | Produced by | Types |
| --- | --- | --- |
| `main` | `logger`, Worker failures | `log`, `uncaughtException`, `unhandledRejection`, `devtools.*` |
| `renderer` | CEF display handler + CDP | `console`, `exception`, `log.entry`, `network.request`, `network.response`, `network.failed`, `navigation` |
| `native` | the core's event queue | `window.created`, `window.closed`, `menu.click`, `dialog.result`, `shortcut.trigger`, … |
| `rpc` | `RpcServer` | `rpc.request`, `rpc.response`, `rpc.error`, `rpc.control` |
| `app` | `devtools.event(...)` | whatever you choose |

Two notes on what is deliberately *not* recorded:

- `Runtime.consoleAPICalled` is not forwarded from CDP. The core's display handler
  already reports console output; forwarding both would duplicate every line. CDP
  contributes what the console cannot express — exceptions with stack traces,
  network failures, navigation.
- `Log.entryAdded` entries with `source: "network"` are dropped for the same reason:
  the Network-domain taps already report every failed request. The duplicate also
  disagreed about severity — `Log` grades all of them `error`, where the network tap
  calls a 4xx a warning and reserves `error` for 5xx — and since `mirin check` fails
  a run on any `error`, a single missing `favicon.ico` failed an otherwise healthy
  app. Failed requests are reported once, by `network.response` / `network.failed`.
- An uncaught renderer error is reported by both producers — the display handler
  (as `console`, no stack) and CDP (as `exception`, with one). The stackless copy is
  dropped, but only for windows the CDP bridge is attached to: the bridge attaches
  after CEF binds its port, so an error thrown by the first window's opening script
  can beat it, and the display handler is the only reporter that sees those.
- `window.moved` / `window.resized` fire continuously during a drag. Only the
  settled value is recorded (200 ms trailing edge), so geometry chatter cannot
  evict everything else from the ring buffer.

RPC payloads are **not** recorded by default: procedure inputs and results carry app
data, and the stream is written to disk in plain text. Set
`devtools.rpcPayloads: true` when you need them.

## Session layout

`mirin dev` opens a session per run under the project's gitignored `.mirin/dev/`:

```txt
.mirin/dev/
  current.json                 → { "session": "<abs path to the newest session>" }
  <session-id>/
    session.json               app metadata + CLI phase timeline   (CLI writes)
    inspector.json             inspector port + token              (Worker writes)
    events.jsonl               the event stream, one JSON per line (Worker writes)
    exit.json                  post-mortem once the app ends       (CLI writes)
    screenshots/               PNGs captured through the inspector
```

Exactly one process writes each file, so nothing needs locking. Session ids are
`YYYYMMDD-HHMMSS-<pid>`, so sorting by name sorts by start time.

`session.json` carries a phase timeline (`compile`, `bundle`, `vite`, `launch`, each
with `start` then `ok`/`fail` and a duration). When an app never appears, the
question is always "how far did startup get?", and that timeline answers it from
disk. `exit.json` adds the exit code, signal, error count, and the last 50 events,
so a post-mortem needs only that one file.

Read the stream with nothing but file access:

```sh
tail -n 50 "$(bun -e 'console.log(JSON.parse(await Bun.file(".mirin/dev/current.json").text()).session)')/events.jsonl"
```

## The inspector

A token-authenticated loopback HTTP server in the Bun Worker. Its endpoint is
published to `inspector.json` once bound, and `mirin dev` prints it.

```sh
TOKEN=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[2]).text()).token)' <session>/inspector.json)
curl -s "http://127.0.0.1:$PORT/state?token=$TOKEN"
```

| Route | Purpose |
| --- | --- |
| `GET /` | route index, so the surface is discoverable |
| `GET /health` | liveness, pid, stream cursor, log file path |
| `GET /state` | windows, RPC routes, app-published state, platform |
| `GET /logs` | the stream, filterable |
| `GET /logs/stream` | the same as SSE, with replay |
| `GET /screenshot` | PNG of a window |
| `GET /snapshot` | accessibility tree (default) or DOM HTML |
| `POST /eval` | evaluate an expression in a window |
| `POST /act` | click / type / key / scroll / wait |
| `POST /cdp` | any DevTools-protocol command |
| `GET /cdp/targets` | which windows the CDP bridge is attached to |

### HTTP traffic

Every request the page issues is recorded as a `network.request`, and every response
as a `network.response` — method, URL, resource type, status, MIME type, time to
response headers, and headers. Successful traffic sits at `debug` so it does not
crowd a default read; a 4xx is a `warn`, a 5xx an `error` (so a failing API fails
`mirin check`). A request that never completed is a `network.failed`.

```sh
curl -s "http://127.0.0.1:$PORT/logs?type=network&token=$TOKEN"
```

```txt
#16 [debug] network.request   → GET  http://127.0.0.1:5173/ui/api.ts
#17 [debug] network.response  ← 200 OK http://127.0.0.1:5173/ui/api.ts
#31 [debug] network.request   → GET  http://127.0.0.1:5173/favicon.ico
#32 [warn ] network.response  ← 404 Not Found http://127.0.0.1:5173/favicon.ico
```

**Bodies are never recorded.** The stream is durable plaintext on disk, and a body is
the most likely place for a credential or personal data to sit. Every event instead
carries the `requestId`, which fetches the body on demand:

```sh
curl -s -X POST "http://127.0.0.1:$PORT/cdp?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"method":"Network.getResponseBody","params":{"requestId":"76030.15"}}'
```

Headers and URLs *are* recorded, with credential-bearing values replaced by
`[redacted]` — `Authorization`, `Cookie`, `Set-Cookie` and anything whose name looks
like a token, key, secret, password or session, in a header **or** a query
parameter. Names survive; values do not. Knowing an `Authorization` header was sent
is the diagnostic value, and its content is none of it.

`devtools.network: false` silences successful traffic. Failures are still recorded
whatever the setting — an opt-out for noise must not quietly weaken the thing that
catches a broken app.

Two `debug` events per request is a lot of volume: a Vite dev boot of a
dependency-heavy app can push several hundred module requests through the
2000-entry ring buffer and evict older events from live `/logs` reads. `mirin check`
is unaffected — it reads `events.jsonl` from disk, which is complete. Raise
`devtools.bufferSize`, or set `network: false`, if you need a longer live window.

### `POST /cdp`

Anything the purpose-built routes do not cover: `Network.getResponseBody`,
`Performance.getMetrics`, `DOM.*`, `CSS.*`, coverage, heap snapshots.

```sh
curl -s -X POST "http://127.0.0.1:$PORT/cdp?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"method":"Performance.getMetrics"}'
```

Returns `{ ok, method, window, result }`. A protocol error comes back as
`{ ok: false, error }` with a 502 rather than an opaque status — an unsupported
domain or a stale `requestId` is information, not a failure of the inspector. The
`method` must look like `Domain.command`; anything else gets a 400 with an example.

This is not a wider trust boundary than the inspector already is — `POST /eval` runs
arbitrary JavaScript in the page — but it reaches domains the page cannot, so it
sits behind the same token and `Host` guards and stays off in packaged builds.

`/logs` accepts `since` (exclusive, from a previous response's `lastSeq`), `level`
(minimum severity), `src`, `window`, `type` (prefix match), `contains`, and `limit`.
Repeated or comma-separated values are both accepted. Unknown filter values are
dropped rather than rejected, so a near-miss still returns logs.

`/state` reports what the app *is*, which the stream cannot: open windows with their
id, name, URL, title, frame, and maximized state; the RPC procedures the app
registered; and any slices published with `devtools.expose`.

Every window has a `name`, including one opened at runtime without being given one —
it falls back to `window-<id>`. A window a tool cannot name is one it can only
address by a numeric id it had to have captured.

### Screenshots return a path

`GET /screenshot` writes the PNG into the session's `screenshots/` dir and returns
`{ path, bytes, format, window, composited }`. A path costs a few dozen bytes where
an inlined base64 PNG costs megabytes, and a consumer that reads files can open it
directly. Pass `?inline=1` for the raw bytes. Also accepts `window`,
`format=png|jpeg`, `quality`, `full=1` (capture beyond the viewport), and `label`
(added to the file name, so a scenario's screenshots are identifiable).

#### Transparent windows are composited, and say so

A transparent/OSR window has no page background — the native material behind the
webview is what a person sees, and CDP knows nothing about it. Captured as-is, the
image has alpha 0 everywhere the page does not paint, so every viewer composites it
onto white and a light-on-dark app reads as a blank page.

So a page with no background of its own is captured over an opaque backdrop, and the
response sets `composited: true` with the `backdrop` that was used. The image is
readable but is no longer pixel-truth; that flag is how a caller tells the
difference. `?backdrop=#rrggbb` forces a colour and `?backdrop=none` opts out.

Two things worth knowing about how this works:

- The backdrop is chosen to contrast with the page's own text colour, not from
  `prefers-color-scheme`. A glass window renders light text whatever the system is
  set to, and picking white there reproduces the blank page exactly.
- It is applied by styling the document, not with
  `Emulation.setDefaultBackgroundColorOverride`. CEF accepts that command on the
  windowless path and then ignores it — captures taken with the override set to
  `none`, red, and black come back byte-identical. Styling the page is the only
  lever that reaches the compositor, so the page is briefly modified and then put
  back exactly as it was.

### Snapshots default to the accessibility tree

`GET /snapshot` returns an indented accessibility tree:

```txt
RootWebArea "Kitchen Sink"
  heading "Kitchen Sink" level=1
  button "Open settings"
  textbox "Search" value="hello"
  checkbox "Dark mode" checked
```

That is the better answer for a reader working in a budget: it already carries the
roles and names a person would use to describe the UI, with none of the class-name
and wrapper-div noise. A page whose `outerHTML` runs to 100 KB usually snapshots to
a few hundred bytes. Structurally meaningless nodes (`generic`, `presentation`,
ignored nodes) are elided while their children are kept, so a button wrapped in four
divs prints as one line. Use `?format=dom` for HTML when you need the real markup.

### Driving the app

`POST /act` takes `{ action, selector, … }`. Selectors accept CSS *or* `text=Save`,
which matches an element's label — trimmed text, `value`, `aria-label`,
`placeholder`, or `title` — preferring an exact match and then the most deeply
nested candidate. Text targeting matters because the snapshot a caller works from
has names, not class attributes.

```sh
curl -s -X POST "http://127.0.0.1:$PORT/act?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"click","selector":"text=Open settings"}'
```

Input goes through `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`
rather than `element.click()`, so a reproduction exercises the same event path a
person's interaction would. Actions: `click` (with `clickCount`), `type` (`text`,
optional `selector`), `key` (a named key), `scroll` (`deltaY`, `deltaX`), and `wait`
(`selector`, `timeoutMs`).

### Security model

The inspector can evaluate JavaScript in a webview and synthesize input, so it is
treated as a capability, not a read-only view:

- Binds `127.0.0.1` only.
- Every request needs the session token, as `?token=…` or
  `Authorization: Bearer …`. The comparison is length-checked and branch-free.
- The `Host` header must name loopback. Without that check, a page on
  `evil.example` whose DNS resolves to `127.0.0.1` could reach the inspector
  carrying a real origin.
- Selectors and expressions are embedded into page scripts with `JSON.stringify`,
  never concatenated.
- **Off in packaged builds.** Every capability resolves to disabled unless
  `devtools.production` is `true`, and individual switches cannot override that
  gate. `mirin doctor` warns when it is set.

## The DevTools-protocol bridge

Screenshots, snapshots, `eval`, and `act` all ride Chromium's DevTools protocol.
CEF exposes it via the `remote_debugging_port` init setting, so the native side is
one config field and a range check (`engine/config.rs`, `engine/boot.rs`) and the
whole client is TypeScript in the Worker.

- `mirin dev` picks a free loopback port from 9222 upward and passes it as
  `MIRIN_CDP_PORT`. The host translates that into the core's
  `remote_debugging_port`; the Worker's client connects to the same port.
- A packaged build gets a port only if an operator sets `MIRIN_CDP_PORT`
  explicitly. Anything that can reach the port can run code in the app's pages.
- The bridge keeps one WebSocket per page and maps each to its mirin window id by
  asking the page for the `webviewId` the preload bootstrap installed. That is the
  only reliable mapping: in dev every window loads the same Vite URL, so URLs
  cannot distinguish them.
- Attachment is asynchronous and never awaited by startup. CEF binds the port
  during browser-process init, after the Worker is already running, so the bridge
  retries for ~15 s and re-scans whenever a window is created.

## CLI

### `mirin check`

The one-shot verification. `mirin dev` is long-lived and interactive; a tool that
backgrounds it has a pid and nothing else. `mirin check` runs the same startup path,
waits for a window, captures a screenshot and a snapshot, collects errors, stops the
app, and **exits non-zero when something went wrong** — so "did my change work?" is
answerable the same way a test is.

```sh
mirin check                      # human summary, screenshot path, UI snapshot, errors
mirin check --json               # one JSON object
mirin check --timeout 60000      # allow a slow first build
mirin check --settle 2000        # wait longer before capturing
mirin check --scenario ./check.ts  # drive a user flow before capturing
```

Exit 1 when no window appeared, the inspector never came up, any `error`-level
event was recorded, or a scenario failed.

### Scenarios

Startup alone proves the window opened. A scenario proves the app *works*: it drives
the real UI and asserts the result, so "does this flow still work?" is answerable in
CI, from one command, with no test infrastructure.

```ts
// check.ts
import { defineCheck } from "mirinjs/check";

export default defineCheck(async (app) => {
  app.step("typed mutation updates the list");
  await app.click("text=add a todo");
  await app.type("ship it");
  await app.click("text=Add");
  await app.waitUntil(
    async () => (await app.evaluate<number>('document.querySelectorAll("li").length')) > 0,
    "the todo never reached the list",
  );
  await app.screenshot("todo-added");
});
```

The scenario runs after the first window has settled and before the final capture,
so the screenshot in the report shows the state the run ended in — including the
state it failed in. The report names the failing step and how long each one took;
`--json` carries the same under `scenario`.

`app` is a `CheckDriver`:

| Group | Methods |
| --- | --- |
| drive | `click`, `type`, `key`, `scroll`, `waitFor`, `sleep` |
| observe | `snapshot`, `evaluate`, `screenshot`, `windows`, `exposed`, `logs`, `cdp` |
| verify | `assert`, `waitUntil`, `expectText` |
| report | `step` |

Two rules worth internalizing, both learned the hard way:

- **Assert on the thing that changed, not on the text being present anywhere.**
  `expectText("ship it")` passes while the text still sits in the input box, so it
  passes even when the mutation is broken. Assert against the list.
- **Use `waitUntil`, not `assert`, after an interaction.** An action returns before
  the RPC round trip it triggered has landed; `assert` reads the present moment and
  will race. `expectText` already polls for this reason.

### `mirin doctor`

Preflight without building: platform support, config validity, entry files, Vite
setup, CEF availability, port contention, and the previous session's outcome. Most
startup failures are environmental and all look identical from outside — a window
that never appears. `doctor` names them, and each problem carries a fix.

```sh
mirin doctor
mirin doctor --json
```

Exit 1 when a check fails outright; warnings do not fail.

### `mirin skill`

Installs the agent skill into `.claude/skills/mirin/`, so a coding agent working in
the project discovers this surface instead of guessing at it. `mirin init` and
`bun create mirinjs` install it into new apps; `mirin skill` is for projects that
already exist, and for refreshing it after a CLI upgrade.

```sh
mirin skill          # install or update, in the current project
mirin skill --json   # { ok, path, replaced, mirinProject }
```

The skill covers the verify-and-drive loop: `check`/`doctor` and their `--json`
shapes, reading a session directory after the app has exited, writing scenarios, and
the inspector's routes. It is deliberately *not* an app-authoring guide — the
scaffold's `AGENTS.md` covers the app model.

Reinstalling replaces the directory rather than merging into it, so a reference file
from an older version cannot linger and be read as current. Other skills in the
project are untouched, and the installed files are not gitignored — the skill is
meant to be committed and shared.

Where the skill lives is worth knowing if you are changing it: the assets are in
`packages/create-mirin/skill/` and installed through `installSkill()` from
`create-mirinjs/skill`. It sits there because both entry points need it — `bun
create mirinjs` has no CLI, and the CLI already depends on the scaffold package.

### `--json`

`check` and `doctor` emit a full JSON report. `dev` emits newline-delimited progress
events (`compile`, `bundle`, `vite`, `launch`, `inspector`). `build` adds a final
result object with the app path, name, bundle id, version, and channel. In JSON mode
nothing but JSON reaches stdout, which is what makes it usable in a pipe.

That covers the whole process, not just mirin's own output. `check` runs `bun build`,
Vite, and the app itself, and all three write to stdout by default; in JSON mode their
output is redirected to stderr instead. It is not discarded — a failed build stays
readable on stderr, it just never lands in the middle of the report.

## App API

```ts
import { devtools } from "mirinjs";

// Publish a domain event into the stream.
devtools.event({ type: "route.change", msg: "/settings" });

// Publish live state, readable at the inspector's /state. The getter runs per read.
devtools.expose("store", () => store.getState());

// Read your own buffer.
const errors = devtools.read({ level: "error", limit: 20 });
```

`devtools.expose` is the one that changes what a tool can see most: it lifts app
state — the current route, a store snapshot, queue depth — into the same surface as
windows and logs, so a reader is not limited to the DOM. `examples/kitchen-sink`
publishes its app shell (tray installed, hotkey registered, windows open) this way,
which is state no snapshot of the page could ever show; the `create-mirin` template
ships a small one so a new app is legible from the start.

## Configuration

```ts
export default defineConfig({
  devtools: {
    enabled: true,        // master switch
    inspector: true,      // bind the loopback HTTP/SSE server
    file: true,           // mirror the stream to events.jsonl
    bufferSize: 2000,     // events kept in memory for /logs
    rpcPayloads: false,   // include RPC inputs/results (off: they carry app data)
    network: true,        // record all HTTP traffic (failures are recorded regardless)
    cdp: true,            // screenshots, snapshots, eval, act, cdp
    production: false,    // permit any of this in a packaged build
  },
});
```

Defaults are asymmetric on purpose: everything on under `mirin dev`, everything off
in a packaged build. In a packaged build the individual switches are ignored unless
`production` is `true` — the gate is `production`, not each switch.

## Known gaps

- **Console output has no stack traces.** It comes from CEF's display handler,
  which reports text only. Uncaught errors also arrive as `exception` events from
  CDP, which do carry stacks; the stackless `console` copy of an uncaught error is
  dropped for windows the bridge is attached to, so it is reported once, with a
  stack. Ordinary `console.error` output still has no stack.
- **First-window early console.** The bridge attaches after CEF binds its port, so
  a `console.log` in the very first inline script of the first page can be missed by
  CDP. The display-handler tap catches console output regardless.
- **`--json` on `release`** is not wired; only `dev`, `build`, `check`, and
  `doctor`.
