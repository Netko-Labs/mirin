# mirinjs.netko.dev — landing page design brief

Input for a Claude Design canvas pass. Nothing built yet. Spec first, artboards
second, implementation third.

Implementation target: a TanStack Start route (`packages/docs/src/routes/index.tsx`) with
sections in `src/components/landing/`, React 19 + Tailwind v4, sharing the root layout
and tokens with the Fumadocs `/docs` tree. Design in components, not one monolith —
the canvas output ports straight into files.

Companion doc: [docs-site.md](./docs-site.md) (framework choice, IA, build order).

## Who is reading

A TypeScript developer who has shipped or abandoned an Electron app, or bounced off
Tauri because the backend is Rust. They know what a main process is. They do not need
"what is a desktop app". They are deciding, in about ten seconds, whether mirin is
real or a weekend project.

Secondary reader: an agent scraping the page for `llms.txt`. Semantic HTML, real
headings, no copy that only makes sense next to an image.

## Positioning

> Build desktop apps with Bun, TypeScript, and Chromium.

The three claims that have to land, in order:

1. **Bun is the main process** — not a Node shim, not a phase. `Bun.*`, `bun:ffi`,
   Workers, `bun test`, top-level await.
2. **Real Chromium everywhere** — CEF on macOS, Windows, Linux. Same rendering, same
   devtools, same web platform on every install.
3. **Rust underneath, invisible to you** — native core ships prebuilt; no Rust
   toolchain to build an app.

Honesty is a feature: `pre-alpha` badge stays above the fold. Nobody trusts a
0.1.0-alpha framework that presents like a 3.0.

## Voice

Terse, technical, confident. Sentences a senior engineer would say out loud. No
"empower", no "seamlessly", no "blazing fast". Code is the argument — every claim
gets ≤10 lines of real, runnable proof underneath it.

## Visual direction

Starting point, not a constraint — push back if the canvas wants something else.

- **Mirin (味醂)** is amber rice wine. Warm amber/gold accent on near-black, with one
  cool secondary for code-block syntax. Reads as "native tool", not "SaaS startup".
- **Glass is the motif.** mirin's differentiator on macOS is transparent windows with
  real native vibrancy (`examples/liquid-glass`). Layered translucency, soft depth,
  a window that looks like it's *on a desktop* rather than pasted on a gradient.
- Dark-first, light theme required and equally finished (Starlight ships both; the
  landing must not be dark-only).
- Type: one geometric/neutral sans for UI, a real mono for code. Big, tight headline
  sizes; generous line-height in body copy.
- The desktop chrome in every screenshot is **real** — actual traffic lights, actual
  vibrancy. No invented browser frames, no floating rounded rectangles that no OS draws.

## Artboards

| # | Section | Job |
| --- | --- | --- |
| 1 | Hero | positioning line, pre-alpha badge, copyable `bun create mirinjs my-app`, real app capture |
| 2 | Why mirin | four claims, each with code proof |
| 3 | Typed RPC | split pane: router left, UI call right, inference visible |
| 4 | Native, not simulated | vibrancy / menus / tray / global shortcuts strip |
| 5 | Process model | host → Worker → Rust core → CEF diagram |
| 6 | Platform matrix | macOS / Windows / Linux with real per-row status |
| 7 | Status + CTA | roadmap honesty, docs, GitHub, contribute |

### 1. Hero

- H1: **Build desktop apps with Bun, TypeScript, and Chromium.**
- Sub: Your main process is Bun — full `Bun.*`, `bun:ffi`, Workers. Your UI is real
  Chromium on every platform. The native layer is Rust, and you never touch it.
- Badge: `pre-alpha · v0.1.0-alpha.25 · macOS arm64 · Windows x64/arm64 · Linux x64/arm64`
- Copy block: `bun create mirinjs my-app`
- Buttons: **Get started** → `/docs/start` · **GitHub** → Netko-Labs/mirin
- **Visual: a real mirin window.** `examples/liquid-glass` or `examples/spotlight`,
  captured on a real desktop, ideally looping. This single asset carries the pitch —
  a window with genuine macOS vibrancy says more than everything below it.

### 2. Why mirin

Four cards, each headline + one sentence + code:

- **Bun-native, permanently.** Bun is the runtime, not a compatibility layer.
- **One engine everywhere.** CEF on all three platforms. Identical rendering, identical devtools.
- **Declarative first.** An app is a typed config, with imperative escape hatches.
- **Typed end to end.** One router definition, full inference on both sides, no stringly-typed channels.

### 3. Typed RPC

The strongest technical differentiator. Split pane, left = main-process router, right =
UI call site, with the inferred type rendered as an editor tooltip. Design job: make the
type *visibly flow* left to right. A connecting line or shared highlight beats a caption.

### 4. Native, not simulated

Horizontal strip of small real captures: transparent window w/ vibrancy · native menu
bar · tray menu · file dialog · global shortcut HUD. Caption each with the API call
that produced it.

### 5. Process model

Adapt the README diagram. Three lanes: **your TypeScript** (Worker) → **mirin host**
(Bun main thread) → **libmirin_core** (Rust: AppKit/Win32/X11 + CEF browser process),
with helper subprocesses hanging off CEF. Show which lane is *yours* — the point is
that you only write in one of them.

### 6. Platform matrix

Real status, not all-green checkmarks. macOS arm64 = most exercised. Windows and Linux
= implemented, less exercised. Say so in the cell.

### 7. Status + CTA

Pre-alpha, what works end-to-end today (`init` → `dev` → `build` → `release`), what's
missing, link to roadmap and CONTRIBUTING.

## Assets to produce (blocking the design)

- [ ] Looping capture of `examples/liquid-glass` on macOS (hero)
- [ ] Still of `examples/spotlight`
- [ ] Stills: native menu bar, tray menu, file dialog, transparent window
- [ ] Editor screenshot of RPC inference (or a faithful recreation with real types)
- [ ] Light-theme variants of the hero capture

## Constraints

- React 19 + Tailwind v4, prerendered to static by TanStack Start. Client JS is unavoidable
  on this stack, so keep it *cheap*: no animation library, no carousel, no scroll-jacking.
  CSS handles motion; JS handles the copy button and the hero video only.
- Tokens live in the shared Tailwind config, not the landing components — the Fumadocs
  docs tree consumes the same palette.
- Theme-aware light + dark; both fully designed.
- Lighthouse ≥ 90 perf; no CLS on the hero (reserve the capture's box). Budget is 90,
  not 95, because React ships on every page — spend it on the hero asset, not on JS.
- Shares header, footer, and design tokens with Fumadocs `/docs/**` — the seam between
  landing and docs should be invisible. Fumadocs UI is themeable via CSS variables; the
  landing palette must be expressible that way or the docs will not match.
- Every code sample is real and lifted from `examples/*`.

## Anti-goals

- No fake testimonials, no "trusted by", no logo wall. There are no users yet.
- No benchmark chart against Electron until we have honest numbers.
- No gradient-blob hero. Show the actual product.
- No claim of stability the version number contradicts.

## Open questions

1. Hero: looping video, animated WebP, or static still + play-on-hover?
2. Is there a mirin logo/mark, or does the wordmark carry it for v1?
3. `netko.dev` parent brand — does the landing inherit Netko Labs styling, or is mirin
   visually independent?
