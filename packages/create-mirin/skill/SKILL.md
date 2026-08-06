---
name: mirin
description: Verify and drive a mirin desktop app without a terminal in front of you. Use when working in a project with a mirin.config.ts and you need to answer "did my change actually work?" — booting the app headlessly, reading its structured event stream, capturing a screenshot or UI snapshot, driving a real user flow and asserting on it, or diagnosing a window that never appeared, a blank screen, a renderer exception, or a failing RPC call. Triggers include "run the app", "check the app", "does this still work", "screenshot the app", "why is the window blank", "the app won't start", "test this flow", "click the button and see what happens".
---

# Verifying a mirin app

mirin apps are native desktop apps: a Bun main process, a CEF webview, typed RPC
between them. `bun run dev` opens a real window and never exits, which means a tool
that backgrounds it has a pid and no idea whether anything worked.

Everything below exists so you never have to guess. **Never report a change as
working because the code looks right — run `mirin check` and read the result.**

## The loop

```bash
mirin check                       # boot once, capture, report, exit non-zero on failure
mirin check --json                # one JSON object on stdout, nothing else
mirin check --scenario ./check.ts # drive a real user flow and assert, then capture
mirin doctor                      # environment/config preflight, without building
```

`mirin check` runs the real startup path, waits for a window, captures a screenshot
and an accessibility snapshot, collects every error the app produced, stops the app,
and **exits non-zero when something went wrong**. Treat the exit code as a test
result. If the project has a `check` script, `bun run check` is the same thing.

Exit 1 means: no window appeared, the inspector never came up, an `error`-level
event was recorded, or a scenario assertion failed. The `reason` field says which.

## Reading the result

In `--json`, every stdout line parses — progress events, then one `result` object.
Subprocess chatter goes to stderr, so `mirin check --json | jq` is safe.

```jsonc
{
  "phase": "result",
  "ok": false,
  "reason": "scenario failed at \"typed mutation updates the list\": the todo never reached the list",
  "windows": [{ "id": 1, "name": "main", "title": "…" }],
  "screenshot": "/…/.mirin/dev/<session>/screenshots/….png",
  "snapshot": "RootWebArea …",          // the UI as an accessibility tree
  "errors": [ /* full events, with stack traces */ ],
  "scenario": { "steps": [ /* name, ok, ms */ ] }
}
```

Read `errors` first — each carries `src` (`main`, `renderer`, `native`, `rpc`), the
message, and a stack when there is one. `snapshot` is the UI in a few hundred bytes;
prefer it over the DOM. `screenshot` is a **path** — read the file to look at it.

## When the app already exited

Every run writes a session directory, so you can diagnose a crash with file access
alone — no live process, no terminal.

```bash
SESSION=$(bun -e 'console.log(JSON.parse(await Bun.file(".mirin/dev/current.json").text()).session)')

tail -n 50 "$SESSION/events.jsonl"   # the full stream: logs, exceptions, RPC, native events
cat "$SESSION/session.json"          # startup phase timeline — how far did it get?
cat "$SESSION/exit.json"             # post-mortem: exit code, signal, last 50 events
ls "$SESSION/screenshots"
```

`session.json` answers "how far did startup get?" (`compile` → `bundle` → `vite` →
`launch`, each with a status). `exit.json` answers "how did it die?".

## Driving a real flow

A scenario clicks, types, and asserts against the running app, then fails the check
when an assertion does. This is how you verify a *flow*, not just a boot.

```ts
// check.ts
import { defineCheck } from "mirinjs/check";

export default defineCheck(async (app) => {
  app.step("adding a todo");
  await app.click("text=add a todo");   // CSS, or text= matching the a11y name
  await app.type("ship it");
  await app.click("text=Add");
  await app.waitUntil(
    async () => (await app.evaluate<number>('document.querySelectorAll("li").length')) > 0,
    "the todo never reached the list",
  );
  await app.screenshot("todo-added");
});
```

Run it with `mirin check --scenario ./check.ts`. Read
`reference/scenarios.md` for the full driver API and **two mistakes that produce
passing checks which verify nothing** — read that file before writing assertions.

## Inspecting a running app

While `mirin dev` is up, the same stream plus live state, screenshots, snapshots,
expression evaluation and synthetic input are available over a token-authenticated
loopback HTTP server. Use this for exploration; use `check --scenario` for anything
you want to be repeatable.

See `reference/inspector.md` for auth and the full route list.

## Rules

- Prefer `mirin check` over `mirin dev`. `dev` never exits; backgrounding it and
  guessing is the failure mode this whole surface exists to remove.
- Report what the run actually said. If `check` exits 1, say so and quote the
  `reason` — do not describe a change as working against a failing check.
- The screenshot of a transparent window is composited over an opaque backdrop so
  it is readable; the response sets `composited: true`. It is not pixel-truth.
- This is a development surface and is off in packaged builds. Do not set
  `devtools.production` to make something work — it ships an endpoint that can
  evaluate arbitrary code in the app.
- Do not add a test framework to answer "does this still work". A scenario file and
  `mirin check` already are the test.
