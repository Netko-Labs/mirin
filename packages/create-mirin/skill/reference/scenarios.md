# Scenarios: driving and asserting

A scenario is a module that default-exports an async function. `mirin check
--scenario ./check.ts` boots the app, waits for the first window to settle, runs the
scenario, then captures — so the screenshot in the report shows the state the run
ended in, including the state it failed in.

The file is loaded *before* the build, so a bad path fails in milliseconds.

```ts
import { defineCheck } from "mirinjs/check";

export default defineCheck(async (app) => {
  app.step("a name for this phase");
  // …drive and assert; throw (or fail an assertion) to fail the check
});
```

## Two traps

Both produce a **passing check that verifies nothing**. Both were hit while building
this surface, on the first real scenario.

### 1. Assert on the thing that changed

`expectText` matches anywhere in the accessibility tree — including the input you
just typed into.

```ts
await app.click("text=add a todo");
await app.type("ship it");
await app.click("text=Add");
await app.expectText("ship it");   // ✗ passes even when the mutation is broken:
                                   //   the text is still sitting in the input
```

Assert against the thing the interaction was supposed to change:

```ts
await app.waitUntil(
  async () =>
    (await app.evaluate<string[]>('[...document.querySelectorAll("li")].map((n) => n.textContent)'))
      .includes("ship it"),
  "the todo never reached the list",
);
```

### 2. Use `waitUntil`, not `assert`, after an interaction

An action returns as soon as the input is dispatched. The RPC round trip it
triggered has *not* landed yet, so a plain `assert` reads the previous state and
races.

```ts
await app.click("text=Add");
const items = await app.evaluate<number>('document.querySelectorAll("li").length');
app.assert(items > 0, "…");        // ✗ races the round trip
```

`waitUntil` polls (2s default) and only fails if the condition never holds.
`expectText` already polls for the same reason. `assert` is for facts that are
already true — a value you just read, a shape you already have.

## Driver API

Every method targets the only window unless you pass `{ window: id }`.

### Drive

| Method | Notes |
|---|---|
| `click(selector, { clickCount?, window? })` | `clickCount: 3` selects a field's contents so `type` replaces them |
| `type(text, { selector?, window? })` | Focuses `selector` first when given |
| `key(name, { window? })` | `Enter`, `Escape`, `Tab`, … |
| `scroll({ deltaY?, deltaX?, window? })` | |
| `waitFor(selector, { timeoutMs?, window? })` | Waits for a selector to match |
| `sleep(ms)` | A guess — prefer `waitFor`/`waitUntil` |

Selectors are CSS **or** `text=Save`, which matches an element's accessible label:
trimmed text, `value`, `aria-label`, `placeholder`, or `title`. Prefer `text=` — it
matches the names `snapshot()` prints, so you never guess at class attributes.

Input is synthesized through the DevTools protocol, not `element.click()`, so a
scenario exercises the same event path a person's interaction would.

### Observe

| Method | Returns |
|---|---|
| `snapshot({ format?, window? })` | Accessibility tree (default) or `format: "dom"` for HTML |
| `evaluate<T>(expression, { window? })` | The expression's value from the page |
| `screenshot(label?, { window? })` | Path to the PNG; `label` goes into the file name |
| `windows()` | `{ id, name, url, title }[]` — every window has a name |
| `exposed()` | Slices the app published with `devtools.expose` |
| `logs(query?)` | The event stream, filtered like the inspector's `/logs` |
| `cdp<T>(method, params?, { window? })` | Any DevTools-protocol command |

`logs` is how you assert on things the DOM cannot show:

```ts
const failed = await app.logs({ type: "rpc.error" });
app.assert(failed.length === 0, `${failed.length} RPC call(s) failed`);
```

HTTP traffic is in the same stream, so a scenario can assert on what the app called
and what came back — including the body, fetched on demand:

```ts
const [call] = await app.logs({ type: "network.response", contains: "/api/todos" });
app.assert(call !== undefined, "the app never called /api/todos");
app.assert(call.data.status === 200, `/api/todos returned ${call.data.status}`);

const { body } = await app.cdp<{ body: string }>("Network.getResponseBody", {
  requestId: call.data.requestId,
});
app.assert(JSON.parse(body).length > 0, "the API returned an empty list");
```

Bodies are never captured into the stream (it is plaintext on disk), and headers and
URLs have credential values redacted — so `logs` will not hand you a token.

### Verify

| Method | Notes |
|---|---|
| `assert(condition, message)` | Right now. Not after an interaction — see trap 2 |
| `waitUntil(condition, message, { timeoutMs? })` | Polls until truthy; a throwing condition counts as "not yet" |
| `expectText(text, { timeoutMs?, window? })` | Polls the a11y tree — see trap 1 |

### Report

`app.step(name)` names the phase. Steps appear in the report with pass/fail and a
duration, stream as `step` events in `--json`, and a failure names the step it
happened in:

```
✓ typed query round-trips to the main process (21ms)
✗ typed mutation updates the list (11ms)
  → the todo never reached the list (waited 2000ms)
```

## Worked examples

In the mirin repo: `examples/hello-react/check.ts` (typed query, mutation, push
events, no failed RPC) and `examples/kitchen-sink/check.ts` (app-shell state via
`exposed()`, opening a second window and checking it is addressable).
