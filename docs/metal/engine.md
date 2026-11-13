# Metal's engine: from a patched GPUI to our own

Status: **proposal** (2026-11-13). Nothing here is built yet. It answers
three questions: what of our GPUI work is worth offering to Zed, what we
should take from upstream, and how to restructure the fork into an engine
of our own for Dashi, multiplatform apps, native components, and later iOS
and Android.

## 1. Where we are

Metal draws with two builds of the same `crates/mirin-metal/src`:

| Build | Base | Our changes | State |
| --- | --- | --- | --- |
| default | `forks/gpui` (gpui 0.2.2 from crates.io, one crate, blade renderer), `forks/taffy` 0.9, `forks/blade-graphics` | 8,500 lines in 49 files | ships in Dashi 0.9 |
| upstream | `forks/zed` (Zed's GPUI at `f8cfc7ed`, 2026-11-10; 49 commits behind `main` on 2026-11-13), `forks/taffy-next` 0.15 | 7,700 lines in 41 files | at parity or faster on most of the stress bench; 4–7 days from being the default (`gpui-next.md`) |

`src/gpui_api/{fork,upstream}.rs` (360 lines) hides the differences.

What the two bases offer:

- **gpui 0.2.2** is one crate with every platform inside it and a renderer
  (blade) upstream has dropped. It has no iOS, no web, and no releases
  since. It is a dead end.
- **Upstream** is split: `gpui` (98k lines, no platform code),
  `gpui_linux` (18k), `gpui_macos` (10k), `gpui_windows` (13k), `gpui_ios`
  (3.6k), `gpui_apple` (5k: the Metal renderer and text system macOS and
  iOS share), `gpui_web` (7k), `gpui_wgpu` (7k: the renderer Linux and web
  use), and `gpui_platform`, which picks one. There is no Android crate.

mirin-metal uses a small part of GPUI: elements, styles, text, lists,
scroll handles, focus, windows. It uses none of the action and keymap
system, the inspector, or `http_client`.

## 2. What to offer upstream

These rows of `forks/zed/MIRIN.md` are small, general, and already marked
upstreamable. Each would be one PR to `zed-industries/zed`:

| Area | Change |
| --- | --- |
| Layout | explicit grid track lists; `justify_items` / `justify_self`; a text's min-content width is its widest word |
| Text | a line cut narrower than its ellipsis draws nothing; a wrapped line aligns by where its ink ends |
| Scrolling | the wheel scrolls the innermost view that can still move; a list's scroll bar range counts its padding; a continuous scroll source moves as far as it says |
| Wayland | `set_min_size` after open; a display's name; a layer surface anchored to opposite edges stretches; a resize asked while maximized; the compose table read at the first key press; one system bus connection |
| wgpu | no indirect-call validation; 4 MiB memory blocks; path textures only while paths are on screen; pipelines built on first use and shared; a font face loaded when first picked |

Not for upstream:

- **Retained subtrees** (the mask map, the device grid, element state
  scopes, the persistent layout tree): about 5,000 lines that change how a
  frame is built. Zed caches views its own way and would not take it.
- **Dashi's protocols** (the unified title bar), the four-thread cap, the
  `mirin::startup` log, and layout rounding that matches taffy 0.9.

Opening PRs on Zed's repository is outward-facing and the owner's call.
Whatever lands there is one less thing to carry, but nothing below depends
on it.

## 3. What to take from upstream

- **The platform split.** It is the reason to base the engine on upstream:
  a platform is a crate that implements `Platform` and `PlatformWindow`,
  so Dashi's Wayland code, macOS, Windows and iOS do not share a file.
- **`gpui_wgpu`** on Linux, and `gpui_apple`'s Metal renderer on Apple
  platforms.
- **`gpui_ios`**, as a starting point. It is young (3.6k lines).
- Upstream's own answers to twelve of our 0.2.2 changes (layer shell,
  idle windows, `QuitMode::Explicit`, UAX #14 line breaking, and others
  listed at the end of `forks/zed/MIRIN.md`).

## 4. The proposal: a hard fork with a seam for platforms

Today the fork is "upstream plus patches": a clean import on the
`forks-upstream` branch, our changes merged on top, every change a row in
`MIRIN.md`. That keeps re-syncing cheap and keeps our design constrained
to what merges. Retained subtrees already strain it: they reach into
`window.rs`, `taffy.rs`, `scene.rs` and `bounds_tree.rs`.

The proposal is to stop tracking and own the code:

1. **Finish the migration to upstream** and make it the default. Delete
   `forks/gpui`, `forks/taffy`, `forks/blade-graphics` and
   `src/gpui_api/`. One base instead of two.
2. **Re-sync once more** to a recent Zed `main`, as the last merge.
3. **Rename and move** the crates out of `forks/zed` into our own
   (working names below). From then on we take upstream changes by
   picking the ones we want, not by merging. `MIRIN.md` becomes a
   changelog of picks.
4. **Restructure** the core around what Metal needs.

### Crates

| Crate (working name) | From | What changes |
| --- | --- | --- |
| `metal-engine` | `gpui` | Retention, the mask map, the device grid and the layout map become modules of the frame, not patches in `window.rs`. The persistent layout tree is the only layout tree. What Metal never calls is removed after measuring what it costs: actions and keymaps, the inspector, `http_client`. |
| `metal-render-wgpu` | `gpui_wgpu` | Vulkan on Linux and Android. |
| `metal-render-apple` | `gpui_apple` | Metal on macOS and iOS. |
| `metal-linux` | `gpui_linux` | Wayland first. Dashi's protocols (title bar, layer surfaces, session lock, file drag) sit behind one `dashi` module and feature, so a plain Linux app builds without them. |
| `metal-macos`, `metal-windows` | `gpui_macos`, `gpui_windows` | Kept close to upstream at first: we have changed little there, and picking fixes stays cheap. |
| `metal-ios` | `gpui_ios` | Later (section 6). |
| `metal-android` | new | Later (section 6). Upstream has none. |
| `metal-native` | new | Native components (section 5). |

`forks/taffy-next` and the three AccessKit forks stay forks: they are
small, their upstreams are libraries with releases, and several of our
taffy changes are upstreamable too.

### What this costs

- **Upstream fixes stop arriving for free.** Zed's `gpui` crate took 28
  commits in the first 13 days of November. After the fork, someone reads
  that log, about monthly, and picks. Platform crates we barely touch are
  where most of the value is, which is why they stay close.
- **The rename is a large, mechanical diff** that makes every later pick a
  hand-port in the core. That is the point of no return; steps 1 and 2 are
  worth doing either way and decide nothing.

### What it buys

- The frame can be designed around retention instead of around upstream's
  immediate-mode frame with our reuse added on. Select inside a scroll
  view, the one bench still behind, is that kind of problem.
- One build, one set of tests, no `GAP` shims.
- A place for native components and mobile that upstream has no seat for.

## 5. Native components

[NativeGPUI](https://github.com/Cafekery/NativeGPUI) (MIT, macOS 26 only)
shows the model: **GPUI owns layout; the OS owns the pixels.**

- A native element takes a slot in the layout like any other element.
- A host (`bridge/host.rs`) keeps an `NSView` per slot, placed above or
  below GPUI's view at the slot's bounds each frame, and carries values
  and events across (`NativeValue`, `NativeHandler`).
- It needs seven patches to `gpui_macos` (frames that follow input, the
  first drawable, a deferred first show, an idle display link, launch
  order). Those are the patches we would take into `metal-macos`.

For Metal:

- **Engine:** a `NativeSlot` element in `metal-engine`, and a
  `PlatformWindow::native_host()` each platform may implement. The slot
  reports its bounds, clip and visibility; the host places a view.
- **Platforms:** AppKit first, by depending on or porting NativeGPUI.
  UIKit and Android views later use the same slot. Windows has no single
  native toolkit to match, and Linux has none: **on Dashi the native
  components are Metal's own**, drawn by `@mirinjs/metal-ui`.
- **React:** a `native` node kind in the patch protocol, and components
  such as `<NativeButton>` in `@mirinjs/metal` that fall back to the drawn
  metal-ui component where the platform has no host. An app written once
  gets AppKit controls on macOS and Dashi's on Dashi.
- **Limits to design for:** a native view above GPUI's view is not clipped
  or overlapped by drawn content, so popovers and scroll clipping need the
  host's care; a retained subtree that moves must move its native views
  too; accessibility comes from the native view, not from our `access/`
  tree.

Public API (`<NativeButton>` and friends) needs the owner's sign-off
(`docs/api-design.md`).

## 6. iOS and Android

Two separate problems. The renderer is the smaller one.

- **The driver.** A Metal app is a Bun process that sends patches to
  `mirin-metal-host` over a pipe. Bun does not run on iOS or Android, and
  iOS does not let an app start another process. Mobile needs the React
  driver in-process on another JavaScript engine (JavaScriptCore on iOS;
  Hermes or QuickJS on Android), with the patch protocol over a channel
  instead of a pipe, and whatever of Bun's APIs apps use replaced. This
  decides whether mobile is months or a year, and should be spiked first.
- **The engine.**
  - iOS: `gpui_ios` and `gpui_apple`'s renderer exist; touch, the software
    keyboard, safe areas and scroll physics need work.
  - Android: a new platform crate (an activity, a Vulkan surface through
    wgpu, input, the keyboard). Nothing upstream to start from.
  - Accessibility: AccessKit has an Android adapter; iOS needs checking.

## 7. Order of work

| Step | What | Effort | Verifiable here |
| --- | --- | --- | --- |
| 1 | Finish the upstream migration; switch the default; delete the 0.2.2 forks and `gpui_api` | 4–7 days | yes (Linux benches and checks) |
| 2 | Last re-sync to Zed `main` | 1–2 days | yes |
| 3 | Rename and move into `metal-*` crates; Dashi protocols behind a feature | 2–3 days | yes |
| 4 | Restructure the frame around retention; remove what Metal never calls, measured | 1–2 weeks | yes |
| 5 | `NativeSlot` and the protocol's `native` node, with a drawn fallback | about a week | Linux fallback only |
| 6 | AppKit host on NativeGPUI's model | 1–2 weeks | no: needs a Mac (CI builds macOS, nobody looks at it) |
| 7 | Spike: the React driver on JavaScriptCore, in-process | about a week | partly |
| 8 | iOS, then Android | after 7 | no: needs devices |

Steps 1 and 2 are right whatever is decided about the rest.

## 8. Decisions for the owner

1. **Hard fork (steps 3–4), or keep tracking upstream?** Recommended: hard
   fork the core, keep the platform crates close.
2. **Names** for the engine crates.
3. **Upstream PRs to Zed:** whether to send the rows in section 2.
4. **Native components' public API**, and whether to depend on NativeGPUI
   or port its approach.
5. **Mobile:** whether to spend the driver spike (step 7) now or after
   macOS.
