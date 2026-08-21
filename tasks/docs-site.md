# mirinjs docs site + landing page

Status: spec draft. Nothing built yet.

## Goal

One site at `mirinjs.netko.dev` that does three jobs:

1. **Convince** — a landing page that makes "Electron, but Bun-native, with Rust
   + CEF underneath" legible in ten seconds.
2. **Teach** — user-facing docs: install, first app, config, RPC, native
   features, build/release/update, platform matrix.
3. **Feed agents** — machine-readable docs (`llms.txt`, raw `.md` per page) so
   Claude/Cursor can write mirin apps correctly, complementing `mirin skill`.

Non-goal for v1: versioned docs, i18n, blog. Pre-alpha ships latest-only.

## Prior art

Verified:

- **Tauri** — Astro + Starlight, docs in a separate repo (`tauri-apps/tauri-docs`).
  Closest comparable: native shell, multi-platform matrix, CLI-driven workflow.
- **Ecosystem split (2026)**: Starlight (Astro) is the framework-agnostic default,
  VitePress the Vue-native one, Fumadocs the Next.js-native one (~10k stars, fastest
  growing React option), Docusaurus the legacy-heavy React one.
- **llms.txt maturity**: Docusaurus / Starlight / MkDocs have the most mature
  plugins; Fumadocs makes you hand-roll it.
- **Elysia** — VitePress, separate repo (`elysiajs/documentation`), README says
  "Written by VitePress". Landing is the VitePress home layout plus custom Vue
  components. Bun-ecosystem sibling, but ships a Vue runtime on every page and splits
  docs from code — both wrong for us.
- **Bun** — Mintlify (hosted), content in-repo at `oven-sh/bun/docs` as `.mdx` +
  `docs.json`. Migrated off a custom React generator; the site source was never
  open-sourced. Relevant to us as a counter-example: closed, hosted, and the reason
  nobody can contribute to Bun's site chrome.

From memory, not re-verified (check before quoting publicly): Electron → Docusaurus,
Vite/Vitest/Hono → VitePress, Zed → mdBook + custom landing.

## Decision: Fumadocs + TanStack Start, single app, `packages/docs`

Owner's call, and it matches the house stack (TanStack Start + React 19, Tailwind v4).
Verified against Fumadocs' own docs before speccing:

- TanStack Start is **officially supported** — starter template exists, maintainer fixes
  bugs against it. Setup is `fumadocs-core` + `fumadocs-ui`, Fumadocs MDX through the
  Vite plugin, `RootProvider` from `fumadocs-ui/provider/tanstack`, a `lib/source.ts`,
  a catch-all `routes/docs/$.tsx`, and `routes/api/search.ts`.
- **Static export works**: SPA mode + prerender in `vite.config.ts`; TanStack Router
  crawls routes automatically, and hidden paths get listed explicitly in `pages`.
- **Search works statically** — indexes are stored at build time and computed in the
  browser. No Algolia, no search server.

What this choice buys, which Starlight would not:

- The landing page is a **first-class React route in the same router**, not a theme
  escape hatch. Claude Design output drops straight in.
- One stack across the whole repo — the site is React 19 + Tailwind v4 like everything
  else you write, so contributors aren't context-switching into Astro.

What it costs, priced honestly:

- **`llms.txt` is hand-rolled.** Fumadocs ships no plugin; Starlight/Docusaurus do.
  Budget a build step that walks `source` and emits `/llms.txt`, `/llms-full.txt`, and
  a raw `.md` per page. ~half a day, and it is now a **first-class work item**, not
  a freebie (see build order step 3).
- **React ships on content pages.** Perf budget below is adjusted accordingly; Astro's
  zero-JS content pages are off the table.
- **Version churn.** Fumadocs + TanStack Start both move fast, and Fumadocs' Start guide
  assumes a *bare* Start + Vite setup. Pin exact versions, keep `vite.config.ts` close to
  the official template, and be suspicious of plugin ordering around `fumadocs-mdx/vite`
  — that ordering is the documented breakage point when presets wrap the Vite config.

Rejected: VitePress (Vue runtime, low landing ceiling), Mintlify/Fern (hosted, closed,
wrong signal for OSS), Starlight (better AI-surface story, but a second stack in the repo
and a themed landing page).

### Placement

`packages/docs` — inside the existing `packages/*` workspace glob, so the root
`package.json` needs no change at all. In-repo (not a second repo) because docs drift
is the top pre-alpha risk and same-PR doc edits beat a separate repo's review queue.

Landing and docs are **one TanStack Start app**, not two. Fumadocs owns `/docs/$`;
`/` is a custom route sharing the root layout, tokens, header, and Tailwind config.

The package is private and unpublished — it sits next to the published packages but
never ships to npm. Set `"private": true` and no `exports` map.

Shape:

```txt
packages/docs/
  vite.config.ts        tanstackStart({ spa, prerender }) + fumadocs-mdx/vite
  source.config.ts      fumadocs-mdx collections
  content/docs/**       user-facing MDX
  src/
    routes/
      __root.tsx        RootProvider (fumadocs-ui/provider/tanstack)
      index.tsx         landing
      docs/$.tsx        docs catch-all + loader
      api/search.ts     search endpoint
    lib/source.ts       fumadocs source adapter
    lib/layout.shared.tsx
    components/mdx.tsx
    components/landing/ landing sections (Claude Design output lands here)
```

Ships with this change: update the folder-structure section of `docs/conventions.md`
in the same PR (repo rule: structure docs move with structure). No workspaces change —
`packages/*` already covers it.

Biome is the formatter here too — Fumadocs templates ship Prettier configs; strip them.

### Hosting

Vercel. Prerender everything (SPA mode + `prerender`), no SSR and no functions — the
site has zero server needs and static removes a whole failure class. If prerender
crawling turns out to miss routes, fall back to the Vercel/Nitro SSR target rather than
hand-maintaining a `pages` list forever.

Preview deploys per PR, production on `main`. Domain `mirinjs.netko.dev`.

Note: you wrote `mirinjs.netko.deb`; spec assumes `.dev`. Correct me if it's not.

## Content model — the important decision

`docs/*.md` today is **contributor-facing source of truth** (architecture, ffi,
conventions, port status). That is not what a user reads.

Split:

| Surface | Lives in | Audience |
| --- | --- | --- |
| `docs/architecture.md`, `conventions.md`, `*-port.md` | repo `docs/`, unchanged | contributors, agents working *on* mirin |
| `packages/docs/content/docs/**` | new, user-facing MDX | people building *with* mirin |
| `docs/api-design.md` | repo, stays the API contract | owner sign-off surface |

The site links out to the repo docs for deep internals rather than duplicating them.
`getting-started.md` and the README quickstart get **rewritten into** the site and
then reduced to pointers — those two are the only real duplication today.

## Site IA (v1)

```txt
/                          landing
/docs/                     what mirin is, when not to use it, status matrix
/docs/start/               install, create an app, project layout, first window
/docs/guides/              windows & materials, typed RPC, menus/tray/dialogs,
                           shortcuts, sidecars, app:// and assets, updater
/docs/concepts/            process model, host/worker/FFI, CEF lifecycle (summaries
                           that link to docs/architecture.md)
/docs/reference/cli/       dev, build, release, init, check, doctor, skill
/docs/reference/api/       config surface, app/windows, rpc, updater, events
/docs/platforms/           macOS / Windows / Linux support matrix + known gaps
/docs/agents/              mirin skill, mirin check scenarios, .mirin/dev stream
/examples/                 hello-react, kitchen-sink, liquid-glass, spotlight, updater
/llms.txt, /llms-full.txt  agent surface
```

## Landing page spec

Above the fold:

- One-line positioning + honest `pre-alpha` badge (no fake maturity).
- Copyable `bun create mirinjs my-app`.
- **A real mirin app on screen**, not a mockup — a looping capture of
  `examples/liquid-glass` or `spotlight`. This is the whole pitch; a screenshot of a
  window with native vibrancy says more than the five bullets under it.

Below:

1. Why mirin — the four README bullets, tightened, each with a 5-line code proof.
2. Typed RPC demo — split pane, main-process router left, UI call right, inference
   visible.
3. Platform matrix — macOS arm64 / Windows x64+arm64 / Linux x64+arm64, with real
   status per row.
4. "How it fits together" — the host/worker/core diagram, animated or not.
5. Bun-native section — `Bun.*`, `bun:ffi`, Workers, bun test in the main process.
6. Status + roadmap + contribute.

Dogfood option worth considering: build the landing hero as a mirin app and ship the
capture from CI, so the marquee is always the current build.

## Build order

1. Scaffold `packages/docs` from the official Fumadocs + TanStack Start template, pin versions, swap Prettier for Biome, verify `bun run build` prerenders.
   — a day (template drift is the risk, not the code)
2. Port `getting-started.md` + README quickstart into `/docs/start/**`, reduce the
   originals to pointers. — half a day
3. **Agent surface**: build step emitting `/llms.txt`, `/llms-full.txt`, and raw `.md`
   per page from `source`. Not free on this stack. — half a day
4. CLI reference generated from the actual command parsers where possible, hand-written
   where not. — a day
5. Guides for the shipped feature families (windows, RPC, menus/tray/dialogs, shortcuts,
   updater), each verified against `examples/kitchen-sink`. — 2–3 days
6. Landing route + Claude Design implementation + captures. — 2 days, mostly capture work
7. CI: build on PR, block on broken internal links; Vercel handles deploy. — half a day

Total ≈ 1.5–2 weeks of focused work. Steps 1–2 alone already beat the current state.

## Acceptance criteria

- [ ] `bun run dev` in `packages/docs` serves landing + docs locally
- [ ] Every published `mirin` CLI command has a reference page with real flags
- [ ] Every code sample on the site is extracted from or checked against `examples/*`
- [ ] `/llms.txt` and per-page `.md` resolve; a fresh agent can scaffold an app from
      them without reading the repo
- [ ] Static search index builds and returns sane results for "vibrancy", "rpc",
      "updater", "tray" — with no search server running
- [ ] Lighthouse ≥ 90 perf on landing and on a docs page; no layout shift on the hero
      capture (budget lowered from 95 — React ships on every page on this stack)
- [ ] `docs/getting-started.md` and README no longer duplicate site content
- [ ] CI builds the site on PR and blocks on broken internal links
- [ ] `docs/conventions.md` documents `packages/docs` in the layout section
- [ ] `bun run build` in `packages/docs` produces a fully static output with no server routes
- [ ] Fumadocs and TanStack Start versions are pinned exact, not caret-ranged

## Open questions

1. `mirinjs.netko.deb` — assuming you meant `mirinjs.netko.dev`. Confirm.
2. API reference: hand-written vs generated from TS types (typedoc → markdown). Generated
   is accurate but reads badly for a declarative config API. Leaning hand-written with
   types embedded from source via a snippet directive.
3. Hero capture: real mirin app built and recorded in CI, or hand-recorded once? CI is
   the honest answer and the harder one.
4. Search: Fumadocs static (Orama in-browser) or Fumadocs Cloud? Static is the default
   here and costs nothing; Cloud only earns its place if the index gets large.
5. Does `mirin skill` (`packages/create-mirin/skill/`) consume the site's `llms.txt`, or
   stay independently authored? Two sources of agent truth is the drift risk.
6. Does the landing ship before the docs are complete? A live landing with a thin
   `/docs` reads worse than a `Coming soon` link, in my view.
