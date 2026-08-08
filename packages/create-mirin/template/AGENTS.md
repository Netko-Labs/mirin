# AGENTS.md — __APP_NAME__

Notes for AI coding tools (and anyone driving this app without a terminal in front
of them). This app is built with [mirin](https://github.com/Netko-Labs/mirin), which
ships a development observability surface so you can see what the app is doing
instead of guessing.

If your tool supports skills, the detail below is also installed as one at
`.claude/skills/mirin/`, loaded on demand rather than kept in context. Refresh it
after upgrading the CLI with `bunx mirin skill`.

## Commands

```bash
bun install
bun run dev      # native window with Vite HMR + typed RPC (long-lived, interactive)
bun run check    # boot once, capture a screenshot + UI snapshot, report, exit
bun run doctor   # check the project and environment without building
bun run build    # standalone app in ./build
```

## Verifying a change

Prefer `bun run check` over `bun run dev`. It runs the same startup path but is
**not** interactive: it waits for a window, captures a screenshot and an
accessibility snapshot, collects errors, stops the app, and **exits non-zero if
anything went wrong**. Treat it like a test.

```bash
bun run check            # human summary
bun run check --json     # one JSON object on stdout
```

If it fails, `bun run doctor` names environmental causes (missing entry file, port
in use, unsupported platform) and reports how the previous run ended.

## Seeing what the app did

Every run writes a structured event stream to a gitignored session directory. It
contains main-process logs, renderer console output, uncaught exceptions with stack
traces, failed network requests, every RPC call, and native window events.

```bash
# the newest session directory
SESSION=$(bun -e 'console.log(JSON.parse(await Bun.file(".mirin/dev/current.json").text()).session)')

tail -n 50 "$SESSION/events.jsonl"          # the stream
cat "$SESSION/session.json"                 # startup phase timeline
cat "$SESSION/exit.json"                    # post-mortem, after the app exits
ls "$SESSION/screenshots"                   # captures
```

While the app is running, the same stream is queryable over a loopback HTTP
inspector, along with live window state, a screenshot endpoint, an accessibility
snapshot of the UI, expression evaluation, and synthetic input (click/type/key).
`bun run dev` prints its URL; the token is in `$SESSION/inspector.json`.

```bash
PORT=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[2]).text()).port)' "$SESSION/inspector.json")
TOKEN=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[2]).text()).token)' "$SESSION/inspector.json")

curl -s "http://127.0.0.1:$PORT/state?token=$TOKEN"              # windows, RPC routes, app state
curl -s "http://127.0.0.1:$PORT/logs?level=error&token=$TOKEN"   # just the errors
curl -s "http://127.0.0.1:$PORT/snapshot?token=$TOKEN"           # the UI as an accessibility tree
curl -s "http://127.0.0.1:$PORT/screenshot?token=$TOKEN"         # returns a PNG path to read
```

`GET /` lists every route. See mirin's `docs/agent-devtools.md` for the full surface.

This is a development surface only: it is disabled in packaged builds.

## Making app state visible

If you find yourself guessing at internal state, publish it — it then appears in
`/state` and in `mirin check` output:

```ts
import { devtools } from "mirinjs";

devtools.expose("route", () => currentRoute);
devtools.event({ type: "order.submitted", data: { id } });
```

## Layout

- `mirin.config.ts` — the app manifest (windows, ids, devtools settings).
- `main/` — the Bun main process: RPC handlers, app lifecycle. Runs in a Worker.
- `ui/` — the React UI, served over the `app://` scheme in builds.

The UI and the main process talk over typed RPC, not HTTP. Add a procedure in
`main/rpc.ts` and call it from `ui/` through the generated client — don't reach for
`fetch` between them.
