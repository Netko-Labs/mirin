# The inspector: driving a running app over HTTP

While `mirin dev` is running, the app serves a token-authenticated loopback HTTP
server. `mirin dev` prints the URL; the endpoint and token are also on disk.

Use this for exploration and one-off questions. For anything you want to be
repeatable, write a scenario (`reference/scenarios.md`) — it runs the same
operations through `mirin check` and gates on the result.

## Connecting

```bash
SESSION=$(bun -e 'console.log(JSON.parse(await Bun.file(".mirin/dev/current.json").text()).session)')
PORT=$(bun -e "console.log(JSON.parse(await Bun.file('$SESSION/inspector.json').text()).port)")
TOKEN=$(bun -e "console.log(JSON.parse(await Bun.file('$SESSION/inspector.json').text()).token)")

curl -s "http://127.0.0.1:$PORT/?token=$TOKEN"     # route index — the surface is self-describing
```

Every request needs the token, as `?token=…` or `Authorization: Bearer …`.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Route index |
| `GET /health` | Liveness, pid, stream cursor, log file path |
| `GET /state` | Windows, RPC routes, app-published state, platform |
| `GET /logs` | The event stream, filterable |
| `GET /logs/stream` | The same as SSE, with replay |
| `GET /screenshot` | PNG of a window |
| `GET /snapshot` | Accessibility tree (default) or DOM HTML |
| `POST /eval` | Evaluate an expression in a window |
| `POST /act` | `click` / `type` / `key` / `scroll` / `wait` |
| `POST /cdp` | Any DevTools-protocol command |
| `GET /cdp/targets` | Which windows the DevTools bridge is attached to |

## Answering common questions

```bash
# What is open, what RPC exists, what has the app published?
curl -s "http://127.0.0.1:$PORT/state?token=$TOKEN"

# Just the errors
curl -s "http://127.0.0.1:$PORT/logs?level=error&token=$TOKEN"

# What did the app do since sequence 42? (cursor from a previous lastSeq)
curl -s "http://127.0.0.1:$PORT/logs?since=42&token=$TOKEN"

# Every failed RPC call
curl -s "http://127.0.0.1:$PORT/logs?type=rpc.error&token=$TOKEN"

# The UI, cheaply — a few hundred bytes where the DOM is tens of kilobytes
curl -s "http://127.0.0.1:$PORT/snapshot?token=$TOKEN"

# Watch live (replays from `since` first)
curl -sN "http://127.0.0.1:$PORT/logs/stream?since=0&token=$TOKEN"
```

`/logs` accepts `since` (exclusive), `level` (minimum severity), `src`, `window`,
`type` (prefix match), `contains`, and `limit`. Unknown filter values are dropped
rather than rejected, so a near-miss still returns logs.

## HTTP traffic

Every request and response the page makes is in the stream — method, URL, status,
type, time to headers, and headers.

```bash
# everything the app called
curl -s "http://127.0.0.1:$PORT/logs?type=network&token=$TOKEN"

# just the failures
curl -s "http://127.0.0.1:$PORT/logs?type=network&level=warn&token=$TOKEN"

# one endpoint
curl -s "http://127.0.0.1:$PORT/logs?type=network&contains=/api/todos&token=$TOKEN"
```

Successful traffic is `debug`, a 4xx is `warn`, a 5xx is `error` — so a failing API
call fails `mirin check`, and a missing favicon does not.

**Bodies are not in the stream** — they are the most likely place for a credential
to sit, and the stream is plaintext on disk. Each event carries a `requestId`;
fetch the body when you actually need it:

```bash
curl -s -X POST "http://127.0.0.1:$PORT/cdp?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"method":"Network.getResponseBody","params":{"requestId":"76030.15"}}'
```

Headers and URLs are recorded with credential values replaced by `[redacted]`
(`Authorization`, `Cookie`, anything that looks like a token/key/secret/session, in
a header or a query parameter). If you need the real value, you are debugging the
credential itself — read it from the app's own config, not from the stream.

## Raw DevTools protocol

`POST /cdp` sends any CDP command, for whatever the routes above do not cover:

```bash
curl -s -X POST "http://127.0.0.1:$PORT/cdp?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"method":"Performance.getMetrics"}'
```

Useful ones: `Network.getResponseBody`, `Performance.getMetrics` (heap size, node
count, layout count — call `Performance.enable` first), `DOM.getDocument`,
`CSS.getComputedStyleForNode`, `Profiler.*`, `HeapProfiler.*`.

Returns `{ ok, method, window, result }`. A protocol error comes back as
`{ ok: false, error }` — a stale `requestId` or an unsupported domain is
information, not a crash. Inside a scenario, the same thing is `app.cdp(method,
params)`.

## Screenshots

`GET /screenshot` writes the PNG into the session's `screenshots/` dir and returns
`{ path, bytes, format, window, composited }`. Read the path — a path costs a few
dozen bytes where an inlined base64 PNG costs megabytes. `?inline=1` returns raw
bytes. Also accepts `window`, `format=png|jpeg`, `quality`, `full=1`, and `label`.

If the window is transparent (a glass/OSR window), the page has no background of its
own and a raw capture is alpha 0 — every viewer composites it onto white and it
reads as blank. Such a page is captured over an opaque backdrop chosen to contrast
with its text, and the response sets `composited: true`. That image is readable but
is **not** pixel-truth, and it does not include the native material behind the
webview. `?backdrop=#rrggbb` forces a colour; `?backdrop=none` opts out.

## Driving

```bash
curl -s -X POST "http://127.0.0.1:$PORT/act?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"click","selector":"text=Open settings"}'
```

Actions: `click` (`selector`, `clickCount`), `type` (`text`, optional `selector`),
`key` (`key`), `scroll` (`deltaY`, `deltaX`), `wait` (`selector`, `timeoutMs`).
Selectors accept CSS or `text=…` matching the accessible label. Add `?window=2` to
target a specific window.

```bash
curl -s -X POST "http://127.0.0.1:$PORT/eval?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"expression":"document.title"}'
```

## Making app state visible

If you find yourself guessing at main-process state, publish it — it then appears in
`/state`, in `app.exposed()` inside a scenario, and in `mirin check`'s report
(`exposed`, printed as `app state:` when non-empty):

```ts
import { devtools } from "mirinjs";

devtools.expose("route", () => currentRoute);
devtools.event({ type: "order.submitted", msg: id });
```

This is the highest-leverage thing you can add to a mirin app for a tool's benefit:
it lifts state that no DOM snapshot could ever show into the same surface as windows
and logs.

## Security

The inspector can evaluate JavaScript and synthesize input, so it is a capability,
not a read-only view. It binds `127.0.0.1` only, requires the session token, and
rejects requests whose `Host` header does not name loopback.

It is **off in packaged builds**. Do not set `devtools.production` to make something
work — that ships an endpoint which can run arbitrary code in the app. `mirin
doctor` warns when it is set.
