# mirinjs docs — structure and writing rules

Tree lives at `packages/docs/content/docs/`. 43 pages, 9 `meta.json`.

**Status: all 43 written.** ~13,000 words, no TODO markers, every page sourced from
the repo rather than invented. What remains is verification, not authoring — see
Acceptance criteria below.

Companions: [docs-site.md](./docs-site.md) (stack, hosting), the brand book (voice,
lexicon, personality budget).

## Shape

```txt
packages/docs/content/docs/
  index.mdx              what mirinjs is · when not to use it · status
  start/         5       install → create → layout → first window → dev loop
  guides/       11       the task-shaped middle: windows, materials, RPC, menus,
                         dialogs, shortcuts, sidecars, app://, build, distribute, update
  concepts/      4       process model, IPC/RPC, CEF lifecycle, security
  reference/    13       config (1) · cli/ (8) · api/ (4)
  platforms/     4       matrix + one page per OS
  agents/        5       check, event stream, inspector, skill
```

Sidebar order is explicit in each `meta.json`; root uses `---Label---` separators to
split *Get started* from *Reference*. Nothing is alphabetical — reading order wins.

## Grounded, not invented

Every page carries a `{/* SOURCE: ... */}` comment naming the file it must be written
from. Pulled from the real surface, not guessed:

| Surface | Truth |
| --- | --- |
| CLI | 7 commands in `packages/mirin-cli/src/index.ts`: `dev build release init check doctor skill` |
| Package exports | 8 subpaths: `.` `/config` `/check` `/devtools/session` `/rpc` `/client` `/codec` `/host` |
| Config | `MirinConfig` in `packages/mirin/src/config/manifest.ts` |
| Concepts | section anchors in `docs/architecture.md` |
| Agents | `docs/agent-devtools.md` |
| Platforms | `docs/{macos-mvp,windows-port,linux-port}.md` |

`/codec` and `/host` are internal-ish and get no reference page yet — they are runtime
wiring, not developer surface. Say so if someone asks rather than documenting them
into public API by accident.

## Deliberately deferred

Reference pages for `menu`, `tray`, `dialog`, `clipboard`, `notification`,
`shortcut`, `sidecar`, `logger`, `updater`, `devtools` do not exist yet — their guides
carry usage, and a signature page per module is a graveyard until the API settles.
Add them when the API stops moving, one at a time, not as a batch of stubs.

## Frontmatter

```yaml
---
title: Typed RPC              # sentence case, no product name, no "guide"/"how to"
description: One router definition, full inference in the renderer.
---
```

`description` is a full sentence, under ~120 chars. It is the search result, the card
subtitle, and what an agent reads first — it must say what the page *does*, never
"Learn about X".

## Writing rules

From the brand book, restated where the writing happens:

- **Docs prose runs at 40% personality.** Direct and warm, one aside per page maximum.
- **First sentence carries information.** No "In this guide", "let's", "simply", "just".
- **Every code sample is real** — extracted from or verified against `examples/*`.
  A sample that has never run is a bug report waiting to be filed.
- **Never explain what a main process is.** The reader has shipped software.
- **Errors and API text get zero personality.** Cause, then the exact fix command.
- **Vocabulary is fixed**: main process / renderer / native core / typed RPC / window.
  Not backend, frontend, binding, webview, or screen.
- **Brewing language never appears in docs prose.** It lives on the landing page, in
  CLI flavour text, and in release posts.

## MDX components available

Fumadocs UI ships these; use them and nothing custom until a real need appears:

| Component | Use for |
| --- | --- |
| `<Callout type="info">` | a constraint or a gotcha — amber styling, never a warning |
| `<Callout type="error">` | something that will break a build or a release |
| `<Tabs>` / `<Tab>` | per-platform commands, bun vs bunx |
| `<Steps>` / `<Step>` | ordered setup only — never for conceptual prose |
| `<Files>` | project layout trees |
| Code blocks with `title=` | any sample longer than one line |

## Write order

1. `start/*` (5) — the only path a new user takes. Nothing else matters if this is thin.
2. `index.mdx` + `platforms/*` (5) — honest status, which builds the trust the rest spends.
3. `guides/{windows,materials,typed-rpc}` (3) — the three things mirinjs does that others don't.
4. `reference/cli/*` + `reference/config` (9) — mechanical, high value, agent-facing.
5. `agents/*` (5) — differentiator nobody else has; also makes the skill self-documenting.
6. Remaining guides (8), then `concepts/*` (4).

Steps 1–3 are the minimum publishable set: 13 pages.

## Acceptance criteria

- [ ] Every `{/* TODO */}` is gone before that page appears in the sidebar
- [ ] Every code sample is lifted from `examples/*` or executed once by hand
- [ ] `description` on every page reads as a sentence, not a label
- [ ] No page explains a concept the reader already has
- [ ] `docs/getting-started.md` reduced to a pointer once `start/*` is written
- [ ] Vocabulary check: no "backend", "frontend", "webview", "simply", "just"

## Open questions

1. Do `concepts/*` pages summarise `docs/architecture.md` or replace it? I lean summarise
   and link — architecture.md is the contributor contract and should stay canonical.
2. Versioned docs: not for pre-alpha. But the first breaking change makes it urgent —
   decide before v0.2, not after.
3. Should `mirin skill` ship the same MDX these pages hold, or a condensed agent-only
   digest? Two sources of agent truth is the drift risk called out in docs-site.md.
