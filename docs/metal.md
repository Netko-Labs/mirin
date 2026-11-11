# Mirin Metal

Metal is mirin without CEF. The developer writes normal React (JSX, hooks,
state, flexbox styles) and it renders as GPU-drawn native UI through
[GPUI](https://www.gpui.rs), the Rust UI framework behind Zed. No web engine,
no Chromium subprocess fleet, no `app://` scheme.

This document is the source of truth for Metal the way `docs/architecture.md`
is for the CEF runtime. Public API changes still go through
`docs/api-design.md` sign-off before leaving alpha.

Status: **alpha, standalone.** `crates/mirin-metal` is excluded from the Cargo
workspace (its own lockfile; CI checks it in its own `metal` job) and
`@mirinjs/metal` is not wired into `mirinjs`, the CLI, or release tooling.
Linux (Wayland, X11 fallback) is the platform it is built and used on; macOS
builds and passes its tests in CI but has not been verified with a real app;
Windows has not been tried. Metal seeds from the earlier `mirin-native` spike (branch
`claude/mirin-native-gpu-validation-vumae7`), imported and renamed on
2026-10-29.

## 0. Relationship to mirin

Metal and mirin are **two different worlds that share a contract**. The owner's
rule (2026-10-29): they share what they can and are almost interoperable, but
Metal is **not free to make breaking changes against `mirinjs`**.

What that means in practice:

- **Shared surface, shared ownership.** `mirin.config.ts` (`defineConfig`),
  `app` (lifecycle, windows, sidecars, resources, workers), `dialog`,
  `clipboard`, `notification`, `shortcut`, `tray`, `menu`, the typed RPC
  helpers, and the updater keep the shapes `docs/api-design.md` defines. Metal
  implements them, it does not redefine them. A change to any of these goes
  through `docs/api-design.md` sign-off with mirinjs in mind, never Metal-only.
- **Metal-only surface lives in `@mirinjs/metal`.** `<View>`, `<Text>`,
  `<TextInput>`, `<ScrollView>`, the element-tree protocol, and the renderer
  options are Metal's own and may move fast while alpha. They never leak into
  `mirinjs`.
- **Same process model.** A Metal app is still Bun host + Worker + Rust core;
  only the engine behind the window differs (GPUI instead of CEF). Apps keep the
  same `mirin.config.ts`, the same `app.windows.open`, the same packaging story.
- **Interoperable, not identical.** An app's main-process code should move
  between the two flavors unchanged. The UI code is different by design: DOM/
  React-DOM in mirin, Metal components in Metal.
- **Breaking changes.** Metal may break *its own* surface during alpha. It may
  not break, fork, or shadow a `mirinjs` export, event name, config key, or RPC
  frame. When Metal needs something the shared surface lacks, propose it for
  `mirinjs` first (feature-flagged or no-op on CEF if needed).

## 0b. Direction: a desktop environment

Metal is the app platform of a new Linux desktop environment the owner is
building: it powers the DE's native apps, and the DE also needs a shell
(panels, launcher, notifications, and similar system surfaces). Design for
that, not for a single demo app:

- **Many resident apps.** Per-app CPU and memory multiply across the desktop.
  Prefer retained trees with patch updates over whole-tree rebuilds, in-process
  FFI over the stdio host, production React builds, and idle processes that do
  no work.
- **Shell surfaces.** Window creation should grow past "one top-level window":
  multiple surfaces per process and Wayland layer-shell surfaces (anchored,
  exclusive-zone panels and overlays) for the shell. Layer surfaces exist in the
  GPUI fork and the alpha host (`MIRIN_METAL_SURFACE`, section 6), and so do
  session-lock surfaces (`{ role: "lock" }`, unlocked only by `unlock()`);
  popups and per-output surfaces do not yet.
- **System-wide concerns.** Theming, fonts, input methods, and accessibility
  should come from the session, not each app. Inter-app IPC and the shell's
  APIs belong in a shared surface, not app-private code.
- **Owning the stack.** Forking GPUI is acceptable when it unblocks
  performance or platform needs; keep the fork's changes small and documented.

## 1. Shape

```txt
normal React ──react-reconciler──▶ element tree JSON ──▶ mirin-metal (GPUI) ──▶ GPU pixels
     ▲                                                          │
     └──────────────── interaction events (node id) ────────────┘
```

| Piece | Lives in | Role |
| --- | --- | --- |
| `@mirinjs/metal` | `packages/mirin-metal` | Custom React renderer. Host components `<View>` and `<Text>`; the first commit sends the host tree as JSON over a transport, and each later one only what it changed (a patch, section "Patches") to a host that takes them; events come back keyed by node id and invoke the matching handler. |
| `mirin-metal` crate | `crates/mirin-metal` | Parses trees and patches strictly (`tree.rs`, `patch/`; unknown fields, ops and ids rejected), keeps the tree and patches it in place (`patch::Document`), maps it to GPUI elements (`render.rs`), owns the window and GPUI's event loop (`window.rs`), and reports interactions (`events.rs`). |
| `mirin-metal-host` | `crates/mirin-metal/src/bin/host.rs` | Alpha transport: a subprocess speaking newline-delimited JSON. Trees and patches in on stdin, events out on stdout. |

The model deliberately mirrors React Native: the driver (React in Bun) owns
state and describes UI; the renderer is a pure function of the latest tree.
A whole tree replaces the last one ("last write wins" per update tick);
patches change it in place, in order (section "Patches").

## 2. Element tree (v2)

```json
{
  "type": "view",
  "props": {"id": "1", "fill": true, "direction": "row", "background": "#111114"},
  "children": [
    {"type": "view", "props": {"id": "2", "width": 220, "scroll": true, "padding": 12}, "children": [
      {"type": "text", "props": {"size": 11, "weight": "semibold", "color": "#8b8b96"}, "children": ["CONNECTIONS"]},
      {"type": "view", "props": {"id": "3", "onPress": true, "hoverBackground": "#1f1f27"}, "children": [
        {"type": "text", "props": {"truncate": true}, "children": ["Check SQLite"]}]}]},
    {"type": "input", "props": {"id": "4", "value": "select 1", "multiline": true, "mono": true,
      "autofocus": true, "onChange": true, "onSubmit": true}}
  ]
}
```

- `view`: `direction`, `gap`, `padding` / `paddingX` / `paddingY`, `width`,
  `height`, `minWidth`, `minHeight`, `maxHeight`, `flex` (grow from a zero
  basis, CSS `flex: N 1 0%` / React Native `flex`), `grow` (grow from the
  content size, CSS `flex-grow`), `shrink`, `fill`, `center`, `align` (`start|center|end|stretch`), `justify`
  (`start|center|end|between`), `background`, `hoverBackground`, `cornerRadius`,
  `borderWidth` (1 or 2), `borderColor`, `scroll` (vertical), `scrollX`, `clip`, `opacity`,
  `onPress`. `id` is required for `onPress`, `hoverBackground`, and `scroll`
  (GPUI keeps per-element state for those); the TypeScript side sends one for
  every node.
- Presses go to the innermost view that handles them, and stop there: a left
  click fires `press` on the deepest `onPress` view under the pointer only,
  a right click fires `contextmenu` on the deepest `onContextMenu` view only,
  and a press starts a capture (`pointer`) on the deepest `onPointer` view
  only. Ancestors with the same handler stay quiet, as on the web when every
  handled press calls `stopPropagation`, and so does a view another is drawn
  over (an event block over a calendar's time slot). A press, a menu, and a
  capture are claimed separately (a slider inside a pressable card drags,
  and a click on the card around it presses). Hover is not claimed: every
  view under the pointer is hovered (`hover`, `hoverBackground`), as in CSS.
  Until 2026-11-05 every view under the pointer with the handler fired (a
  checkbox inside a pressable row toggled and pressed the row); code that
  relied on that must call the outer action from the inner handler. The
  renderer decides in `src/press.rs`: GPUI runs listeners in reverse paint
  order, so the first view to claim a press is the innermost, topmost one,
  and the claims reset in each press's capture phase.
- `text`: string children plus `color`, `size`, `weight`
  (`normal|medium|semibold|bold`), `mono` (system monospace via `fc-match`),
  `truncate`, `opacity`.
- `input`: `id` (required), `value`, `placeholder`, `multiline`, `secure`
  (bullets instead of text), `mono`, `size`,
  `color`, `placeholderColor`, `background`, `padding`, `cornerRadius`,
  `borderColor`, `focusBorderColor`, `width`, `height`, `minHeight`, `flex`,
  `fill`, `autofocus`, `onChange`, `onSubmit`, `onKey`, `selection`
  (`{"start","end"}`), `onSelection`, `selectionColor`, `runs`, `highlights`
  (`[{"start","end","color"}]`), `lineNumbers` (`{"width","color"}`), `align`
  (`"right"`: a one-line field's text at its right edge, 2 px in for the
  caret; `textAlign` on the TextInput). A one-line text longer than its field
  is drawn shifted to keep the caret in view, the least move, never past
  either end of the text (`src/follow.rs`); one that fits is never shifted. The
  shift is checked after each paint, so a caret that leaves the view comes
  back one frame later. The renderer owns the
  editing buffer, caret, selection, and focus (`window::InputState`); a
  different `value` in a later tree resets the buffer (controlled-input
  semantics), and so does a new `revision`: the caret goes to the end, or to
  `selection` when the tree has one. Enter submits a single-line input;
  multiline inserts a newline and Ctrl/Cmd+Enter submits.
  Caret and selection (`src/field.rs`, `src/field/{keys,press,words}.rs`,
  `src/selection.rs`, `src/caret.rs`): a click puts the caret at the
  character under it (past a glyph's middle is after it), a drag selects
  from there wherever the pointer goes until the button lifts, a double
  click selects a word (or a run of spaces or punctuation) and a drag from
  it grows by words, a triple click selects the line (the paragraph in a
  multiline field), and a Shift-click extends the selection. ← → move by
  character and Ctrl/Alt+← → by word; Home and End go to the line's ends
  (the drawn, soft-wrapped line in a multiline field) and Ctrl+Home/End to
  the text's; ↑ ↓ move by drawn line in a multiline field, keeping their x,
  and past the first or last line go to the start or end. Shift with any of
  them extends the selection; without it a selection collapses to the end
  the key moves toward. A single-line field still reports ↑ ↓ to `onKey`
  (Shift+↑ ↓ select to its start or end). Backspace and Delete remove the
  selection, Ctrl+Backspace/Delete a word. Ctrl/Cmd+A selects all,
  Ctrl/Cmd+C copies the selection and Ctrl/Cmd+X cuts it to the system
  clipboard (never from a `secure` field), and Ctrl/Cmd+V pastes over it;
  typing and a composition replace it too. A compositor that maps Mac keys
  (Dashi turns ❖← into Home, ❖↑ into Ctrl+Home, ⌥← into Ctrl+←) gets the
  Mac's moves from these. The selection is drawn behind the text in
  `selectionColor` (a translucent blue without it) while the field is
  focused; the caret glyph stays at the selection's moving end. The driver
  reads it through `onSelection`, `{"type":"selection","nodeId","start",
  "end","textHash"}` on every change (UTF-16 offsets into the text,
  JavaScript's string indices, `start <= end`; a composition is not part of
  them; `textHash` is the text they are into, 32-bit FNV-1a over its UTF-16
  code units, `events::text_hash`), and sets it
  through `selection` (`start` where it begins, `end` where the caret goes):
  a different `selection` in a later tree selects it, except one the field
  reported itself (a late echo, kept as `change` values are). The host
  names `MIRIN_METAL_SELECTION` (`SELECTION_MARKER`) for a driver checking
  for this.
  Highlights and line numbers (`src/marks.rs`): `highlights` washes each
  range (UTF-16 offsets into the text, as `selection`'s) in its own color
  behind the glyphs, under the selection, whether or not the field has the
  keyboard (find's matches, the current one deeper); an input method's
  composition at the caret pushes later ones along. `lineNumbers` gives a
  multiline field (never a `secure` one) a gutter `width` px wide at its
  left, added to its `padding`: each line (from the start or a line break,
  not a soft wrap) has its number, counting from 1, in `color` and the
  field's own font and size, at its first drawn row, its right edge 10 px
  (`LINE_NUMBER_GAP`) before the text. Neither is part of the laid-out text
  (it lays out the same with or without them), and both are painted only
  where the field shows through its clip, so a long document in a scroll
  view pays only for what is on screen. A press in the gutter places the
  caret at the start of the line beside it. Ctrl/Cmd+V pastes from the system clipboard. Tab / Shift+Tab move focus
  to the next or previous input or `focusable` view (section "Focus"). Input methods (Fcitx 5, IBus;
  text-input-v3 on Wayland) work in every field, single-line or multiline,
  in a window or on a layer surface: the focused field is GPUI's input
  handler (`src/ime.rs`), its composition shows underlined at the caret and
  is not part of the value (no `change` until a commit, which inserts at the
  caret, in place of a selection), and the caret's rectangle goes to the
  compositor so the candidates open under it, wherever a click or a key put
  it. A click while composing makes the composition text where it shows
  first. Plain typing is unchanged: keys still arrive as
  keys (`src/field.rs` edits for both).
  Styled runs (`src/runs.rs`): `runs` is a list of `{"start","end"}` (UTF-16
  offsets into the value, as the selection's) with how that text is drawn:
  `color`, `background` (a wash behind it), `weight`, `italic`, `underline`,
  `strikethrough`, `size`, and `press`. The value stays plain text; runs only
  change how it is drawn, so the caret, the selection and every edit work as
  in plain text (a Markdown note drawn formatted as it is typed: its
  `**bold**` bold, its markers faded). Where runs overlap the later one wins,
  attribute by attribute, and a composition's underline is drawn over them.
  `size` draws the whole paragraph (or paragraphs) the run is in at that
  size, in a multiline field: GPUI lays a line out at one size, so mirin's
  GPUI fork shapes each paragraph at its own (`StyledText::
  with_paragraph_sizes`), and the caret, the selection's wash, ↑ ↓ and the
  pointer follow each line's own height. A press on a run with `press` (a
  checkbox in the text) leaves the caret where it was and is reported:
  `{"type":"runpress","nodeId","run","offset","shift","ctrl","alt","meta"}`,
  the run's index in `runs` and the offset nearest the pointer (where a
  click would have put the caret). A placeholder and a `secure` field draw
  plain. At most 8192 runs are drawn. The host names `MIRIN_METAL_RUNS`
  (`RUNS_MARKER`) for a driver checking for this; an older host refuses a
  tree with `runs`. A `secure` field takes no input
  method: while it (or nothing that takes text) has the keyboard, text input
  is off, so what is typed there never reaches one. The host names
  `MIRIN_METAL_IME` (`IME_MARKER`) for a driver checking for this.
- Raw keys and the wheel: a view with `onKeyDown` (and an `id`) takes the
  keyboard when it first appears and whenever it is pressed, and emits
  `{"type":"keydown","nodeId","key","text"?,"ctrl","alt","shift","meta",
  "repeat"}` for every key (GPUI's key name, the text it types, Super as
  `meta`); the key stops there. `onWheel` emits `{"type":"wheel","nodeId",
  "dx","dy"}` in lines (pixel deltas divided by the line height). For views
  that handle input themselves, like Dashi's terminal; such views are never
  virtualized rows.
- Height transitions: a view with `heightTransitionMs` (and an `id`) follows
  its content height over that many ms (ease-out cubic, `1 − (1 − t)³`,
  capped at 1000) instead of jumping when the content grows or shrinks; its
  content is clipped meanwhile, and its first frame is drawn at the natural
  height (appearing doesn't animate). The renderer draws the view inside a
  block clip whose height it eases, measuring the content after each layout
  (`src/height.rs`), so the view's own `flex`/`grow` have no effect and a
  shadow it casts is cut: put it on a content-sized view inside the one with
  the shadow. Absent or 0 changes at once. A driver that turns motion off
  (Reduce Motion) leaves it out.
- Colors are `#RGB`, `#RRGGBB`, or `#RRGGBBAA`.
- Events: `{"type":"press","nodeId","shift","ctrl","alt","meta"}` (the
  modifiers held, Super as `meta`; all false for Space or Enter on a focused
  view; `contextmenu` carries them too), `{"type":"change","nodeId","value"}`,
  `{"type":"submit","nodeId","value"}`, `{"type":"selection","nodeId","start",
  "end","textHash"}`, `{"type":"runpress","nodeId","run","offset","shift","ctrl","alt",
  "meta"}` (styled runs, above), `{"type":"layout","nodeId":"root",
  "nodes":[{id,x,y,width,height}]}` in reply to a layout query, and
  `{"type":"frame","nodeId":"root"}` once a newly opened window has painted its
  first frame (once per open; a driver times an open with it), and
  `{"type":"visibility","nodeId":"root","visible"}` when the compositor
  suspends the window or stops (section "Visibility"), and
  `{"type":"typing","nodeId":"root","typing"}` when a text field takes the
  keyboard (`true`) or the last one lets it go (section "Focus").
- Opening: a host started with its window (not `MIRIN_METAL_DEFERRED`) opens
  it on the driver's first tree, so the first frame the compositor shows is
  the app. It used to open at once on a dark stand-in (`#111114`) and show
  that until the first tree arrived and painted: about a second of a black
  window for an app slow to render its first tree. A title sent before the
  tree is the one the window opens with; simulations wait for the window. If
  no tree comes within 2 s, or the driver goes away first, the window opens
  on the stand-in. Desktop surfaces (layer shell, the lock screen) still
  open at once: a lock screen must lock now, and a layer surface's stand-in
  is transparent. With `MIRIN_METAL_TRACE=1` the host logs how long the
  window waited and `first content frame painted, N ms after the host
  started` (or `first placeholder frame …` when it opened on the stand-in).
- Simulation (checks and tools): a stdin line `{"sim": ...}` instead of a tree.
  `{"kind":"click","id"}` / `{"kind":"click","x","y"}` focuses an input (its caret stays where it was) or
  fires a pressable view's `press` (resolved against the painted bounds;
  GPUI's mouse dispatch is crate-private, so hit-testing is approximated),
  `{"kind":"key","keystroke":"ctrl-enter"}` and `{"kind":"type","text"}` go
  through GPUI's real keystroke dispatch, `{"kind":"layout"}` asks for bounds
  (only nodes painted in the latest frame), `{"kind":"scroll","id","dy"}`
  scrolls a scroll view or virtualized list, and `{"kind":"focus","id"}` gives
  a field or `focusable` view the keyboard without pressing it (a screen
  reader's focus).
- Grid: `grid` lays children out as a CSS grid (taffy) with `gridColumns` /
  `gridRows` track lists (a number is px; `"1fr"`, `"25%"`, `"auto"`,
  `"min-content"`, `"max-content"`; `{"min","max"}` is `minmax`), item
  placement `colStart`/`colEnd`/`colSpan`/`rowStart`/`rowEnd`/`rowSpan`,
  `justifyItems`/`justifySelf` (inline axis; `align`/`alignSelf` are the block
  axis), and per-axis `gapX`/`gapY`. Tracks are parsed strictly. Explicit
  track lists and inline-axis alignment come from mirin's GPUI fork.
- Strings placed directly in a view (a component returned one) render as
  text in the view's `textStyle` (`@mirinjs/metal`) instead of being dropped.
- Virtualized lists: a vertical `scroll` view with 64 or more rows in a plain
  column layout (stretch alignment, no wrap, no own interaction) renders as a
  GPUI `list`. The rows may sit inside up to four layout-only wrappers (only
  padding, gap, and flex; e.g. `<ScrollArea><div className="p-4">…`), whose
  padding is added to the list's. Only rows near the viewport are laid out and painted; row
  heights are cached across frames, and a new tree invalidates only the rows
  that changed. Horizontal padding moves onto each row, vertical padding
  scrolls with the rows.
- Scroll views (`scroll`, `scrollX`, and virtualized lists):
  - **Range.** A view scrolls exactly to the end of its content: taffy's
    content size for the view (its children's margin boxes and what overflows
    them visibly, then its end padding), plus its end border, less its size
    (`Window::layout_scroll_extent` in the GPUI fork). GPUI measured the span
    between its children's border boxes, which dropped the last child's end
    margin and the border, and counted the top padding twice once the bar's
    canvas sat at the view's corner (Software's pages scrolled 22 past their
    end). The offset is clamped to the range every frame, so a window that
    grows (maximized, full screen, tiled) or content that shrinks leaves the
    view at its new end, never past it.
  - **Content keeps its length.** A child of a view that scrolls along its
    direction keeps its length there and the view scrolls, as React Native
    lays a ScrollView's content out: CSS's `flex-shrink: 1` squeezed any
    child whose least length is small (one that clips, `overflow: hidden`,
    has none) or that taffy underestimated (wrapped pills), cutting its end
    off. A child that says `flex`, `flexGrow` or `flexShrink` (sent as
    `shrink: true`) still does as it says.
  - **The wheel** scrolls the innermost view under the pointer that can still
    move that way; at its end the turn goes on to the view around it. Every
    view used to take every turn, so a list scrolled with its page.
  - **The scroll bar** (`scrollbar.rs`) is an overlay, as on macOS: a thumb 6
    wide along the right edge (and the bottom, for `scrollX`), drawn over the
    content, with no room kept for it. It shows while the view scrolls and
    while the pointer is in the 14 px band at the edge, then fades. Shown, it
    takes the pointer (not the wheel) from the content under it: the thumb
    drags, a press on the track pages (the view less 24). Hidden, it takes
    nothing. It is a zero-size canvas child that reads the view's geometry at
    prepaint, so it never counts toward the content.
  `@mirinjs/metal` exposes this as `testID` props, `transport.simulate()`,
  `root.nodeId(testID)`, and `root.lastTree()`; Anko's `apps/metal/check.ts`
  is the worked example.

The TypeScript side (`packages/mirin-metal/src/lib/serialize.ts`) maps React
Native-style props: `<View style>` (`flex`, `alignItems`, `justifyContent`,
`overflow: "scroll" | "hidden"`, `hoverBackgroundColor`, …), `<Text
numberOfLines={1} style={{ fontWeight, fontFamily: "monospace" }}>`,
`<TextInput value onChangeText onSubmitEditing onKeyPress multiline autoFocus style>`
(`onKeyPress` reports Escape, and ArrowUp and ArrowDown in a single-line field,
for list navigation), React Native's `selection` (`{ start, end }`, controlled),
`onSelectionChange` (called with `{ start, end }`; a selection the field made
in a text the app has since replaced, which arrives late, is not passed on:
`lib/field-texts.ts` follows what each field holds, from its `change` events
and the values the app sets, and checks the event's `textHash` against it;
the exported `textHash(text)` hashes as the host does, for a stand-in host in
an app's checks) and
`selectionColor` on it,
`runs` (`TextRun`: `start`, `end`, `color`, `backgroundColor`, `fontWeight`,
`fontStyle`, `textDecorationLine`, `fontSize`, `press`) and `onRunPress`
(called with `{ run, offset, modifiers }`),
`highlights` (`TextHighlight[]`, `{ start, end, color }`; an empty list sends
nothing), `lineNumbers` (`{ width, color }`) and `focusNextOnSubmit` (Enter
also moves the keyboard on, as Tab does, in the host, so keys typed right
after land in the next field: a title, then its body), `submitBehavior`
(`"submit"` makes Enter submit a multiline field instead of breaking its line:
a title that wraps but is one paragraph; Ctrl/Cmd+Enter always submits); a run's `color` may be
translucent (GPUI blends a highlight's color over the text's, so the host
sends it opaque with its alpha as a fade),
and `TextInputDefaults`, a context whose value (`{ selectionColor }`) every
`<TextInput>` below it takes unless it sets its own (a theme gives fields its
selection color once), and
`<ScrollView>` (a scrolling `<View>`).

### Patches

After its first whole tree, a driver sends only what each commit changed,
and the host changes the tree it keeps in place (`src/patch/`). What a patch
costs to send, parse and apply follows the change, not the tree: on the 15k
node stress bench a card's highlight is ~0.2 KB instead of 1.3 MB (5b).

- **Negotiation.** A host that takes patches says so on stdout as it starts,
  before anything else: `{"type":"protocol","nodeId":"root","patches":1}`
  (`PATCH_PROTOCOL`; the binary also names `MIRIN_METAL_PATCHES`). A driver
  patches only a host that announced a version it speaks; until then, and
  for a host that never announces (older ones), it sends the whole tree on
  every commit, as before. Switching, it sends the whole tree once more, now
  with ids on every node. An older driver never patches, so a new host takes
  its whole trees as before. An old host given a patch line would refuse it
  (a line it can't parse), never draw it wrong; the announcement keeps a new
  driver from sending one.
- **Ids.** Every node has an id: views and inputs their `id`, and a
  patching driver also gives `text`, `svg` and `image` nodes an `id` prop
  (only patches address them by it; they take no events). `@mirinjs/metal`
  uses each host instance's number, and `r1`, `r2`, … for a string placed
  directly in a view (a text node of its own). Ids are unique in the tree,
  and the root has one, or no patch applies.
- **Lines.** `{"patch":[op, …]}`, ops applied in order as one update:
  - `{"op":"insert","parent":P,"before":B?,"node":N}`: the new subtree `N`
    (a node as in a whole tree, children included) under the view `P`, in
    front of its child `B`, or last without `before`. Every id in `N` is new.
  - `{"op":"move","id":C,"parent":P,"before":B?}`: the node `C` already in
    the tree, with its subtree, under `P` before `B` (a keyed reorder; React
    only reorders within a parent, but the host allows another one, never
    inside `C` itself).
  - `{"op":"remove","id":C}`: `C` and its subtree go (never the root).
  - `{"op":"set","id":C,"node":N}`: `C`'s own props, and a text node's
    strings, become `N`'s; `N` keeps `C`'s type and id. A view keeps its
    children (`N` has none); every other node is replaced whole.
  Parsing is strict (`deny_unknown_fields`, unknown ops refused), and so is
  applying: an unknown id, a `before` that is not a child of the parent, a
  parent that is not a view, an id already in the tree, a set that changes
  a type or an id. A root that is replaced (another host type, another root
  component) goes as a whole tree.
- **Resync.** A patch applies whole or not at all: when an op fails, the
  ops before it are undone (`patch/undo.rs` keeps how to take each back),
  so a frame never shows half a commit. The host logs `patch refused` on
  stderr, sends `{"type":"resync","nodeId":"root","value":reason}`, and
  drops every patch until a whole tree comes (they were made against a tree
  it doesn't have); the driver sends one at once (`lib/tree-sync.ts`).
  Patches before the window opens, or while a resident host's window is
  hidden, apply to the tree it keeps for the next open.
- **The runtime spec's v2.** `docs/metal/spec.html` §7 sketches the FFI
  protocol's batches (`create`/`append`/`insert`/`update` with set and unset
  lists, `ctx` for UI contexts, a length-prefixed commit). This stdio form
  is its first step and differs: ops are objects, a set sends a node's
  whole props (a node's head is small; a key-level diff can come with the
  binary encoding), and there is no `ctx` yet. The ids, ordering,
  atomicity, strictness and the whole-tree fallback are the same.
- **What changed, for the renderer.** Every update (a whole tree, a patch)
  has a generation, one more than the last (`Document::generation`).
  `Document::own_generation(id)` is the update a node's own props, text, or
  list of children last changed in, and `subtree_generation(id)` the update
  anything at or under it did; a whole tree changes every node, and an id
  the document doesn't know answers the newest generation. The renderer
  keeps what it built for a subtree whose generation it has already drawn.
  The host's own state follows the same way: after a patch it walks the
  tree only for what the patch could concern (`patch::Touched`: fields,
  key views, the Tab order, scroll views, height transitions, virtualized
  lists, whose rows are refreshed when their list's generation moves), and
  a field whose props changed is brought in line by itself.
- **Trace.** With `MIRIN_METAL_TRACE=1` the host logs `line parsed (N KB)
  in Xms` for every line, then `tree applied in Xms` for a whole tree or
  `patch applied (N ops) in Xms` for a patch (`bench/stress.tsx` reads
  both).
- **Driver side.** The host config logs each mutation React makes
  (`appendChild`, `insertBefore`, `removeChild`, the portal container's
  own) and each node whose props or text changed (`lib/commit-log.ts`; a
  shallow look first, so a re-render that changes only handlers or makes new
  but equal `style` objects sends nothing), and `lib/tree-sync.ts` turns the
  log into ops after the commit: a new subtree goes whole in its insert, a
  node already sent is moved, and a set goes only when the node's head (its
  JSON without children) differs from what was sent. Events find their
  handler on the node's current props by id, so a handler that changed
  needs nothing sent. `root.lastTree()` is the whole tree as the host now
  has it, and `root.nodeId(testID)` the last node in document order with
  that `testID`, as before.

### Focus

Which view the keyboard goes to (`src/focus/`; the rules are pure and tested
in `focus/order.rs`). A host that has it names `MIRIN_METAL_FOCUS`
(`FOCUS_MARKER`); one without refuses a tree with these props.

- `focusable` (and an `id`) on a view: Tab and Shift+Tab reach it, in
  document order together with every `input`, wrapping around; Space or
  Enter press it (`press`, with no modifiers, as the key goes down and not
  again while it repeats; GPUI's own key-up click is ignored). A press with the pointer doesn't focus
  it: GPUI's automatic focus on mouse down is off for the whole window
  (`pointer.rs` prevents it in the capture phase), fields and `onKeyDown`
  views focus themselves when pressed, and a press anywhere gives the
  keyboard back from a focused view to the window.
- `focusGroup` on a view: the focusable views inside it are one Tab stop,
  entered at the one that last had the keyboard, else the one whose
  `access` says `selected` or `checked`, else the first. The arrow keys
  move between them, stopping at the ends. With `selectsOnFocus` the arrows
  also press the view they reach (a sidebar, a tab list). Fields never join
  a group.
- `focusTrap` on a view: while it is in the tree, Tab stays inside it (the
  last trap in document order holds it), and a focused view outside it gives
  the keyboard back to the window. A trap appearing does too, so Enter goes
  to the sheet's own keys, not to a button behind it.
- The ring: a focused view shows a ring only after the keyboard moved focus
  (CSS `:focus-visible`), and only while its window is the active one (it
  has the keyboard): another window in front hides it, and it comes back
  when this one is active again. `RING_WIDTH` 2 px wide, `RING_OFFSET` 2 px out, its
  corners the view's `cornerRadius` plus 4, drawn as an absolute child (a
  view that clips cuts it). Its color is the nearest `focusRingColor` on the
  way up (`#RRGGBB[AA]`), else a blue. Fields keep their
  `focusBorderColor` instead.
- The window's keys: when no field, `onKeyDown` view, or focusable view
  has the keyboard, the window itself does (a focus handle on the outermost
  element), so keys still arrive. Every key that reaches it and that the
  focus model doesn't use (Tab; the arrows in a group; Space and Enter on a
  focused view) goes to the last `onWindowKey` view in document order as
  `{"type":"windowkey","nodeId","key","text"?,"ctrl","alt","shift","meta",
  "repeat","pasted"?}`, where Ctrl+V carries the clipboard's text in
  `pasted`. Such a view never takes the keyboard; a new one appearing gives
  the keyboard back to the window (a driver remounts it to take the
  keyboard back from a field). A field's or an `onKeyDown` view's keys are
  its own, taken or not: a terminal keeps Tab.
- Autofocus: fields new in a tree that ask for the keyboard (`autofocus`)
  don't race. One wins, the same every time: a field inside the shown trap
  before one behind it, then the first in document order, as in HTML
  (`Order::autofocus`, `focus/order.rs`). They used to be taken in a map's
  order, so a sheet's field and another new field asking at once left the
  caret in either.
- Typing: the host tells the driver when a text field takes the keyboard
  and when none has it any more,
  `{"type":"typing","nodeId":"root","typing":true|false}`; only changes are
  sent, a window opens not typing, and a view with `onKeyDown` (a
  terminal's grid) is not typing. An app whose menus show ❖A, ❖C, ❖Z…
  gives those keys to the field while one types (Dashi's menus channel).
  A host older than the event never sends it; no marker, no prop.
  `@mirinjs/metal`'s `NativeEvent` gains `{ type: "typing"; nodeId: "root";
  typing: boolean }` (`host.ts` parses it; `render.ts` passes it to
  `transport.onEvent` listeners only).
- Accessibility: a focusable view is a node (a button when pressable, else
  a group) with the Focus action, and it is the tree's focus while it has
  the keyboard, so Orca follows Tab.
- `@mirinjs/metal`: `focusable`, `focusGroup`, `selectsOnFocus`,
  `focusTrap`, `onWindowKeyDown(event: WindowKeyInfo)` on `<View>`,
  `style.focusRingColor`; `onPress` gets `{ bounds, modifiers }` and
  `onContextMenu` `{ x, y, modifiers }`, where `modifiers` is
  `{ shift, control, alt, super }` (all false from an older host).
- Not yet: focus moved by the driver (a `focus()` call), Home and End in a
  group, a grid's two-dimensional arrows, rings on views in a virtualized
  list that clip them.

### Visibility

A window learns when no one can see it. On Wayland the compositor says so
with xdg_toplevel's `suspended` state (xdg-shell 6; mirin's GPUI fork binds
`xdg_wm_base` up to 6 and reads it, `forks/gpui/MIRIN.md`): minimized, on
a desktop that isn't shown, fully covered where the compositor tracks that.
The host sends `{"type":"visibility","nodeId":"root","visible":false}` when
it is suspended and `true` when it is seen again; only changes are sent and
a window opens seen, so a compositor that never suspends sends nothing.
Dashi's shell suspends its windows off screen (minimized, hidden, on another
Space) through its compositor's `suspend` request. An app that polls stops
meanwhile (Dashi's Activity Monitor); GPUI keeps drawing as before, which
costs nothing while the compositor sends no frame callbacks.

## 2b. `@mirinjs/metal-ui`: shadcn/ui on Metal

`packages/mirin-metal-ui` ports shadcn/ui `main` 1:1 so apps built on that
design system move to Metal by changing imports. All upstream components and
all registry examples are ported with markup, props, variants, and `className`
strings unchanged (`scripts/port-ui.ts` rewrites only imports).

- A JSX runtime (`jsxImportSource: "@mirinjs/metal-ui"`) renders lowercase
  tags (`div`, `button`, `input`, `select`, `table`, `form`, `svg`, `img`)
  through Metal views.
- A Tailwind engine (`src/tw/`) evaluates class strings, variants against
  element attributes, breakpoints against the window width, and CSS custom
  properties through the tree.
- Primitives (`src/primitives/`) stand in for Radix and the third-party
  libraries shadcn uses; overlays are React portals into a window-wide layer
  anchored by painted bounds.
- `<form>` behaves like the DOM: submit and reset buttons (also through
  `form="id"`), `FormData` on submit, and named controls registering values.

Layout follows CSS where shadcn depends on it: grids are native (track lists,
placement, `justify-*`), tables are rows sharing one grid template (pinned
widths, the rest `minmax(0, 1fr)`; no measuring), `has-*` variants match what
descendants render (`has-[>svg]`, `has-data-[slot=x]`, `has-[[aria-checked=true]]`,
`:disabled`/`:checked`), inline-level boxes keep their content width in block
flow, and text measures its min-content width as its widest word (mirin's
GPUI fork). Images round to their clipping ancestor's radius.

Differences from the web: no keyboard navigation or Escape handling yet; no
transforms or animations; one radius per element; `peer-*`, `even:`/`odd:`,
and descendant selectors are ignored; charts are bar-only.
`demo/browser.tsx` browses every example natively and `bun test` mounts each
one headlessly plus behavior tests per component group. `PORTING.md` is the
porting guide.

## 3. Process model (decision pending)

The full runtime design (process and thread model, `libmirin_metal` ABI, UI
protocol v2, RPC, config, shell surfaces, tooling, budgets, milestones R1–R7,
and the decisions awaiting owner sign-off) is specified in
[`docs/metal/spec.html`](metal/spec.html). The desktop shell plan built on it
(compositor strategy, shell processes, capabilities, services, roadmap S0–S5)
is [`docs/metal/shell.html`](metal/shell.html). The summary below predates both.

GPUI, like CEF, wants the process main thread. The two cannot share it, so
Metal is a **separate app flavor**, never a mode of a CEF window. The proposed
model keeps mirin's host/Worker split and swaps the engine:

```txt
host (bun --compile)             Bun Worker                 libmirin_metal (Rust)
  dlopen libmirin_metal  ─────▶  React + @mirinjs/metal  ──▶  mirin_metal_run() owns main thread
  spawn Worker                   RPC/app APIs reused          GPUI window + event loop
```

- Commands (tree updates) cross the flat C ABI as JSON, like `mirin_window_*`.
- Events (press, window lifecycle) come back through a polled queue, matching
  `engine::events` in the CEF core.
- The stdio host is the alpha stand-in for that FFI transport and stays useful
  for out-of-process debugging.

Decisions, following §0:

1. **Packaging.** `mirinjs` stays the one app API. Metal is consumed as
   `@mirinjs/metal` (components + renderer) on top of it, not as a separate
   runtime entry that re-exports `app`/`dialog`/… Apps import `app` from
   `mirinjs` and `<View>` from `@mirinjs/metal`.
2. **Native library.** A second cdylib, `libmirin_metal`, so the CEF core stays
   free of GPUI's dependency tree and Metal apps ship without a CEF download.
   It exposes the same command/event envelope (`{"v":1,"kind":...}`) and the
   same feature modules (`engine/dialog`, `clipboard`, `notification`, …) so
   the Worker-side `mirinjs` code is shared verbatim; only window creation and
   the element-tree commands differ.
3. **Diffing.** Landed 2026-11-10 as a Metal-only change, without touching
   `mirinjs`: after the first whole tree a patching host gets `insert` /
   `move` / `remove` / `set` ops (section 2, "Patches").

## 4. Platform notes

### Linux (Fedora first)

Verified 2026-10-29 on Nobara 44 (Fedora 44 base), KDE Plasma on Wayland, AMD
Radeon 890M with Mesa RADV:

- GPUI renders natively on Wayland (`WAYLAND_DISPLAY`) and falls back to X11
  when it is unset. Both paths open a window, draw the tree, and apply piped
  updates. GPUI draws its own client-side title bar on Wayland.
- Build deps (dnf): `cmake ninja-build libxkbcommon-devel libxkbcommon-x11-devel
  wayland-devel vulkan-loader-devel fontconfig-devel freetype-devel libxcb-devel
  libX11-devel`. Runtime needs a Vulkan driver (RADV, ANV, or NVK; llvmpipe works
  as a software fallback).
- **libc pin.** `gpui 0.2.2` pulls `xattr 0.2.3` through `zed-async-tar`, which
  fails to compile against `libc >= 0.2.190` (`ENOATTR` was removed on Linux).
  The crate's `Cargo.lock` pins `libc 0.2.186`; refresh with
  `cargo update libc --precise 0.2.186` after any `cargo update`. Revisit when
  GPUI bumps its tar fork.
- `proc-macro-error2 2.0.1` triggers a future-incompat warning; harmless today.
- **Idle windows don't commit.** Stock GPUI commits a Wayland surface after
  every frame callback, drawn or not, so an unchanged window commits at the
  display's rate and an on-demand compositor never goes idle. The fork asks
  for a frame callback only when a frame draws and wakes idle windows when
  they become dirty (`forks/gpui/MIRIN.md`). Measured in dashi-comp: an
  idle desktop draws nothing.

### Unified title bar (Dashi)

Apps such as macOS Notes put their own toolbar in the title bar: the sidebar and
toolbar run to the top edge and the window controls float over the content.
Metal does this on Dashi's compositor through a Dashi-private protocol,
`dashi-chrome-v1` (`dashi_chrome_manager_v1.get_chrome(toplevel)` makes a
`dashi_chrome_v1`; `set_style(standard | unified)`; the event
`controls(x, y, width, height)`). The XML lives in dashi-comp
(`comp/protocols/dashi-chrome-v1.xml`) and is copied into the GPUI fork
(`forks/gpui/protocols/`).

- **Ask for it.** `spawnNativeHost(binary, { titleBar: "unified" })`, or
  `MIRIN_METAL_TITLEBAR=unified`. The value is `standard` (default) or
  `unified`; anything else makes the host exit with status 2. In the host it
  becomes `TitlebarOptions::appears_transparent`, and the Wayland client binds
  the manager when it is advertised and sets the style before the window's
  first commit (`forks/gpui/MIRIN.md`). Windows still ask for server-side
  decorations, which Dashi needs to honor the style.
- **What the compositor does.** No title bar and no title text; the surface
  starts at the top of the frame. Dashi still draws the rounded corners, the
  shadow, and the traffic lights at their usual spot, now over the surface; a
  press on a light goes to the compositor, everything else to the app. The
  app moves the window with `xdg_toplevel.move` and zooms it with
  `set_maximized` / `unset_maximized`.
- **The controls area.** `controls` is the rectangle (window coordinates) the
  lights occupy, with margins; the app keeps it empty. The host sends it as a
  `chrome` event, `{"type":"chrome","nodeId":"root","titleBar":"unified",
  "controls":{"x":0,"y":0,"width":80,"height":28}}`, when the window opens and
  on every change; `useWindowChrome()` returns `{ titleBar, controls }` and
  re-renders on it.
- **Drag regions.** `<View dragRegion>`: a press there starts a compositor move
  (`window.start_window_move()`), a double click zooms
  (`window.zoom_window()`). A descendant with `onPress`, `onPointer`, or a
  `TextInput` keeps its clicks: those handlers run first and mark the press
  taken, and the region ignores a taken press. In metal-ui write
  `<header data-drag-region>`.
- **Fallback.** On a compositor without the protocol (KDE, GNOME) the window
  keeps the standard server-side title bar, `titleBar` reports `"standard"`,
  and `controls` is `null`. The same holds if Dashi does not honor the style
  (the app asked for client-side decorations): the effective style is only
  `unified` while the compositor reports a controls area. Apps should render
  the same toolbar either way, padding by `controls` when it exists.
- **First frame.** The hook starts at `standard / null` until the first
  `chrome` event, which arrives at startup; an app that pads by `controls`
  re-lays out once.

### Files: drag and drop (Wayland)

- **Out.** `<View dragFiles={{ paths, icon?, iconSize? }}>`: a left press there
  and a move of 6 pixels with the button held starts a Wayland drag
  (`wl_data_device.start_drag`, GPUI's `Window::start_file_drag`, added in
  the vendored copy). It offers `text/uri-list` for copying; `icon` (PNG,
  JPEG, or SVG) is drawn into a shm buffer, `iconSize` logical pixels across
  (48 by default) at the window's scale, centered under the pointer. A
  click without moving is still a press. `paths` are read when the drag
  starts, so a view can pass the selection it belongs to.
- **In.** `<View onDrop={(event) => …}>`: files dragged over the window, from
  any app (this one too), reach the deepest painted `onDrop` view under the
  pointer, inside every scrolling or clipping ancestor (`drag.rs`):
  `enter`, `over` while moving, `leave`, or `drop`, with window coordinates,
  the paths, and the keyboard's modifiers. Only file lists are accepted
  (GPUI's external paths); text drags are not.
- **Not yet.** Other platforms (GPUI's default is to refuse the drag), a
  drag of anything but files, and choosing move over copy in another app:
  the drag offers copy only; an app moving files within itself decides on
  its own.

### Accessibility (AT-SPI)

- **The tree.** Every window publishes an accessibility tree over AT-SPI
  through AccessKit's Unix adapter (`src/access/`), so Orca reads Metal's UI.
  It is built after each paint from the element tree and what only the
  renderer knows: painted bounds, which field has the keyboard, and what is
  typed in it (the buffer, not the driver's lagging value; never a password
  field's). The adapter watches whether assistive technology is on and hands
  the tree to the accessibility bus only then; the tree is rebuilt only when
  the element tree, the focus, the typed text, or the window's focus changed.
- **What it says.** A view with `access` (`accessibilityRole`,
  `accessibilityLabel`, `accessibilityState`, `accessibilityLiveRegion` in
  `@mirinjs/metal`, React Native's names) is a node with that role, name and
  state; a view with `onPress` and no role is a button named by its text; a
  text is a label; a field is a text input (a password input when secure)
  named by its placeholder, or an editable combo box when its role says
  `combobox`. Views that say nothing are only layout: their children join
  the node above. A labelled option, button, status… stands for its text,
  which isn't read twice. A focused combo box points at the selected option
  as its active descendant, so the selection is announced as it moves while
  the keyboard stays in the field; a live region is announced when it
  changes. Node ids are hashes of the elements' ids, stable across trees.
- **Actions.** A screen reader's press is a simulated click on that element
  (`sim.rs`), the same path the person's click takes. Its focus gives a
  field or `focusable` view the keyboard (`{"kind":"focus"}`) and never
  presses it.
- **The application.** The AT-SPI application is named by the driver
  (`MIRIN_METAL_APP_NAME`, `appName` on `spawnNativeHost`), else by the
  first window's title, never the host binary's file name (AccessKit's
  default, which made Orca call every app "mirin-metal-host"). The first
  window of a host names it for the host's life. The name is set through
  mirin's fork of AccessKit's Unix adapter (`forks/accesskit_unix/MIRIN.md`).
- **Windows shown and gone.** A window that has the keyboard when its tree
  first reaches the bus announces itself: `window:activate`, then the
  focused node, so Orca reads a resident launcher's field each time it is
  shown (AccessKit sent only the focus, from a window Orca never saw
  activate, and Orca ignored it). A window that closes or is hidden sends
  `window:deactivate` first.
- **Drivers.** The host binary names `MIRIN_METAL_ACCESSIBLE`
  (`ACCESSIBLE_MARKER`); a host without it rejects a tree with `access` props
  (unknown fields are refused), so a driver greps the binary before it sends
  them, as it does for `MIRIN_METAL_RESIDENT`. `MIRIN_METAL_ACCESSIBLE=0`
  turns the tree off. `MIRIN_METAL_APP_NAME` needs no check: a host from
  before it ignores the variable.
- **Not yet.** Text navigation inside a field (caret, selection, words), a
  tree for macOS and Windows (AccessKit has adapters for both), tables and
  sliders' values, and scrolling a node into view on request.

### macOS

Renders through Metal (the Apple API) with no extra system deps. Not yet
re-verified on this branch.

### Windows

Renders through DirectX. Not yet verified.

## 5. Milestones

- **M0 — alpha imported** ✅ (2026-10-29). Crate + package renamed to Metal,
  builds standalone on Fedora, `bun test` / `tsc` / biome / `cargo test` /
  `cargo clippy -D warnings` / `cargo fmt --check` pass, stdio demo renders and
  applies updates on Wayland and X11.
- **M1 — real app loop.** 🚧 **Anko runs on Metal** (`apps/metal` in the Anko
  repo, 2026-10-29): React in Bun calls Anko's service/repository packages
  directly, and the sidebar, SQLite connection form, query editor, and results
  table render through GPUI; verified on Fedora/KDE by driving the whole flow
  with the keyboard (Tab, typing, Ctrl+Enter). Text input (`<TextInput>`, renderer-owned buffer,
  caret, focus, paste, change/submit events), scroll views, hover, borders,
  alignment, truncation, and monospace text landed 2026-10-29 and were driven
  with synthetic keyboard input on Fedora/KDE. Still open: press verified only
  through the fake transport, image nodes. (Text selection landed
  2026-11-06: caret placement, drag and Shift selection, Cut and Copy, a
  controlled `selection`. The tree patch protocol landed 2026-11-10.)
- **M2 — in-process transport.** `libmirin_metal` C ABI + polled event queue
  replacing the stdio host; host/Worker boot shared with the CEF runtime;
  `docs/architecture.md` gains the Metal arm.
- **M3 — CLI.** `mirin dev` / `build` / `release` for Metal apps on Linux
  (flat dir, AppImage / rpm / deb), then macOS and Windows.
- **M4 — app shell parity.** Menus, tray, dialogs, clipboard, shortcuts,
  notifications through the same `engine/` feature modules.

## 5b. Performance

`bun bench/native.tsx` in `packages/mirin-metal-ui` opens the example browser
in an off-screen virtual compositor (`startHeadlessDisplay()`, which runs
`kwin_wayland --virtual`; `--visible` uses the desktop), clicks between
examples and scrolls the example list through the simulation channel, and
splits each click into driver, transport, and frame stages from the host's
`MIRIN_METAL_TRACE=1` log. For CPU profiles, build the host with
`--features profiling` and set `MIRIN_METAL_PROFILE=<path>` (folded stacks).

Findings and fixes (2026-10-29, release host, 866-node tree, medians):

| | before | after |
| --- | --- | --- |
| click → painted frame | 50.4 ms | 20.4 ms |
| full frame (GPUI layout + paint) | 17.5 ms | 1.2 ms |
| scroll frame p95 | 18.4 ms | 1.7 ms |

- GPUI lays out the whole window every frame (taffy, no cross-frame cache);
  layout was ~60% of each frame. Long scroll lists are now virtualized.
- `flex: 1` used to grow from the content size, so each nested `flex` level
  re-measured the whole subtree. It now grows from a zero basis, which is
  also what CSS `flex-1` and React Native `flex` mean.
- The host woke on a 16 ms poll; it now wakes when a message arrives. Lines
  are parsed once and the tree is shared per frame instead of deep-copied.
- React ran its development build because Bun leaves `NODE_ENV` unset
  (2–3× slower renders); `packages/mirin-metal-ui/bunfig.toml` defines
  production. Apps should do the same until the Metal runner sets it.
- Debug builds optimize dependencies (`[profile.dev.package."*"]`); unoptimized
  GPUI/taffy made the debug host several times slower.

- The Vulkan loader opened every installed driver. On a hybrid laptop that
  mapped NVIDIA's whole stack into each app even though rendering ran on the
  AMD GPU (host RSS 389 MB). The host now asks the compositor for its main
  device (`linux-dmabuf` feedback) and sets `VK_LOADER_DRIVERS_SELECT` to that
  device's driver before GPUI starts (`gpu.rs`): 87 MB, and the discrete GPU
  can stay suspended. User `VK_*` driver variables win; `MIRIN_METAL_GPU=all`
  opts out. The virtual display forces Mesa EGL so it composites on the same
  GPU a real session does.
- Idle cost: no frames and ~20 ms of host CPU per 5 s with the example browser
  open.

- Layout fidelity (same day): `bench/shot.tsx` screenshots examples in a
  private virtual KWin session (own D-Bus, so Spectacle talks to it) for
  visual review without touching the desktop. Fixes it drove: native grid and
  `has-*` (above); text min-content; a taffy fork for fit-content flex base
  sizes (`forks/taffy/MIRIN.md`); flex's zero minimum no
  longer overrides explicit `min-w`/`min-h`; `w-full` on inputs is width,
  not growth; the full Tailwind v4 palette (generated).

- Opening (2026-11-05, release host on a private headless weston): a window
  opened on the dark stand-in and showed it until the driver's first tree
  painted. With a driver whose first tree takes 1 s (an app slow to start),
  the stand-in was on screen from 91 ms to 1044 ms; the window now opens on
  that tree and its first frame, at 1063 ms, is the app. Apps whose first
  tree is quick (Dashi's Activity Monitor, Software, Calculator on the
  laptop: the tree is in by ~60 ms) paint their content first, 76–97 ms
  after the host starts, where the stand-in painted 14–38 ms before it.

- Patches (2026-11-10, B3; release host, `bench/stress.tsx` in
  `packages/mirin-metal`, ~15k nodes, one card's style or one text per
  update, medians of two runs each, baseline host and this one back to
  back). `driver` is from the simulated input to the last line sent, so it
  includes the host's turn to report the input; `parse` and `apply` are the
  host's trace (whole tree, or patch):

  | | whole tree | patches |
  | --- | --- | --- |
  | sent per update, select / type | 1367 KB / 1367 KB | 0.2 KB / 0.3 KB |
  | driver, select | 12 ms | 1 ms |
  | host parse + apply, select | 11.8–14.4 ms | 0.0–0.1 ms |
  | host parse + apply, type | 11.8–12.6 ms | 0.0–0.1 ms |
  | input → painted frame, select | 364–424 ms | 365–425 ms |

  The driver alone (React and the send on a fake transport, no host): a
  select 13.6 → 0.4 ms; typing 22.3 → 10.4 ms, where typing re-renders the
  whole dashboard (no `memo`) and React's own reconciliation is the rest
  (the stress bench's `driver` for typing, ~165–210 ms either way, waits
  for the host to finish a frame before it reports the keystroke). Before
  `patch::Touched`, a patch walked the whole tree once per kind of host state
  (fields, focus, lists, …): 0.8–1.3 ms of the apply. The frame (GPUI's
  layout and paint, ~130–160 ms at this size) is unchanged by patches and
  dominates; the generations above are what it can use to skip unchanged
  subtrees. On the example browser (`bench/native.tsx`, ~900 nodes, one
  example swapped for another per click): 180.7 → 4.3 KB per click, parse
  1.0 → 0.1 ms, apply 0.6 → 0.6–1.2 ms (the swapped example is inserted
  under a scroll view, so its lists and scroll views are checked), driver
  alone 7.7 → 6.5 ms; its click-to-frame time is the frame's.

Open: React work per update (the demo re-renders its whole list on select),
GPUI's full relayout for trees that are not long lists, and the
accessibility tree, rebuilt whole after every update.

## 5c. Who uses it: Dashi

Dashi, the Linux desktop of section 0b, is Metal's first and main consumer. Its
shell surfaces (menu bar, dock, launcher, notifications, lock screen) and its
apps (Activity Monitor, Software, Calculator, Notes, Calendar, a terminal, and
more) are React on `@mirinjs/metal` and `@mirinjs/metal-ui`, each window drawn by
a `mirin-metal-host` process its driver spawns (`spawnNativeHost`). Dashi
depends on the packages by path (`"@mirinjs/metal": "file:../mirin/..."`, see
section 6 on sharing one React) and builds the host from this crate. Most of
the GPUI fork's changes (`forks/gpui/MIRIN.md`) came from Dashi's needs:
layer-shell and session-lock surfaces, the unified title bar on Dashi's
compositor, idle windows that stop drawing, text input only while a field
takes text, truncation and wrapping fixes, and scroll views that end where
their content does.

## 6. Run it

Build and check the crate (from `crates/mirin-metal`; Linux build deps in
section 4):

```sh
cargo build --release --bin mirin-metal-host
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                      # headless: GPUI's test platform, no display
```

The forks live at the repository root (`forks/gpui`, `forks/taffy`,
`forks/accesskit_unix`; `forks/README.md` explains the upstream branch). The
GPUI fork's own tests build it alone with this crate's lockfile:

```sh
cd ../../forks/gpui && cp ../../crates/mirin-metal/Cargo.lock . \
  && CARGO_TARGET_DIR=../../crates/mirin-metal/target/gpui-alone cargo test --lib --features test-support; \
  rm Cargo.lock
```

The TypeScript packages are checked with the rest of the repository
(`bun run fmt-lint`, `bun run typecheck`, `bun run test`). The root `test`
script runs `@mirinjs/metal-ui`'s tests from their package directory, because
Bun applies that package's `tsconfig.json` (`jsxImportSource`) and
`bunfig.toml` only for the directory it runs in; run them by hand with
`cd packages/mirin-metal-ui && bun test`.

Run a demo:

```sh
cd crates/mirin-metal && cargo build --bin mirin-metal-host
cd ../../packages/mirin-metal && bun demo/counter.tsx
```

The host reads `MIRIN_METAL_TITLE` and `MIRIN_METAL_SIZE=1280x820`.
`MIRIN_METAL_SURFACE=<json>` opens a Wayland layer-shell surface (a panel, a
dock) instead of a window; the JSON is the `windows.*.surface` shape from
`docs/api-design.md` §1a (`layer`, `anchor`, `exclusiveZone`, `keyboard`,
`margin`, `namespace`; only the `layer` role so far), the surface is transparent
where the tree is, and opening fails on compositors without wlr-layer-shell.
`spawnNativeHost(binary, { surface })` sets it. `MIRIN_METAL_TITLEBAR=unified`
(`titleBar`) puts the app's toolbar in the title bar on Dashi (section 4,
"Unified title bar"). `MIRIN_METAL_APP_ID` (`appId`)
names the app to the compositor, which docks and taskbars group windows by;
`MIRIN_METAL_APP_NAME` (`appName`) names it to screen readers (section 4,
"Accessibility").
A `{"title":"…"}` stdin line retitles the window afterwards (`setTitle()` on the
transport): the compositor's title bar, the window switcher, and taskbars show
the new title (a terminal's running program and grid size).
`MIRIN_METAL_MIN_SIZE=274x436` (`minWidth` and `minHeight`, both or neither)
is the smallest the person can make the window: GPUI's `window_min_size`,
which Wayland sends as `xdg_toplevel.set_min_size`, so the compositor stops a
resize there. For an app whose layout stops working below a size (Dashi's
Calculator); anything but `WxH` with both at least 1 is an error, and a
surface ignores it. A `{"size":{"width":W,"height":H}}` stdin line resizes the
window afterwards (`setSize()` on the transport), in logical px: an app
growing to show a sidebar and shrinking when it goes. The compositor has the
last word (a zoomed, tiled, or full-screen window keeps its size, and a later
configure may restore the size it chose). A maximized or full-screen window
is not resized at all: the size it goes back to moves by as much as the
request differs from its size now, so a sidebar shown while zoomed still has
its room once the window is restored (`forks/gpui/MIRIN.md`); the app learns the size it got from
the root's layout, as ever (the root fills the window, so its `onLayout`
reports the window's size on every change: a tile, an edge dragged, a zoom).
A `{"minSize":{"width":W,"height":H}}` line changes the least size afterwards
(`setMinSize()` on the transport; GPUI's `Window::set_window_min_size`,
`forks/gpui/MIRIN.md`): an app that needs more room while it shows more
(Calculator's tape beside its keypad). It doesn't resize the window; send a
size too (the host applies the least size first). A host from before either
refuses the line on stderr and ignores the variable.
`MIRIN_METAL_CLOSE=ask` (`askToClose`) lets the app answer a close from outside
itself: when the compositor asks the window to close (`xdg_toplevel.close`: its
close control, a shell's close, quit, or logout), the window stays and the host
writes `{"type":"close-request","nodeId":"root"}`. The app closes by ending the
host (`close()` on the transport), at once when it has nothing to lose, or
after it asked (unsaved changes, a running job); keeping the window is not
answering. The default, `now` (or unset), closes at once as before, and a host
from before it ignores the variable and closes at once too. Windows only: a
surface or a deferred host closes as it always has. A hung app stays closable
by the shell's force path (ending the process), not by the host.
`MIRIN_METAL_CAPABILITIES=shell.toplevels` (`capabilities`) makes the host follow
every window over wlr-foreign-toplevel-management on a second Wayland connection
(`src/toplevels.rs`): it writes `{"type":"toplevel","toplevel":{...}}` and
`{"type":"toplevel-closed","id":N}` lines, and `{"toplevel":{"id":N,"action":"activate"}}`
on stdin activates, minimizes, maximizes, or closes a window (`onToplevel` and
`toplevel()` on the transport). Unknown capabilities fail at startup. `MIRIN_METAL_DEFERRED=1`
(`deferred: true`) starts the host with no window: GPUI, its GPU context, and
the fonts load at once, and the window opens when a
`{"open":{"title":…,"appId":…,"width":…,"height":…,"surface":{…},"titleBar":…}}`
line arrives (`open()` on the transport), so a shell can keep one warm and show
a menu or sheet without the seconds a new host takes to start. A deferred host
is also resident: `{"hide":true}` (`hide()`) closes its window but keeps the
process, the GPU context, the fonts, and the newest tree (trees sent while it
is hidden are kept, newest wins; title lines and simulated input are dropped,
the next open names the window), and the next `open` line opens it again
drawing that tree on its first frame, as often as the driver likes. A hide is
not a close: the host doesn't exit and `onClose` doesn't fire; closing the
window any other way (the person, the compositor) still ends the host. An
`open` while the window is shown, and a `hide` while it is hidden or on a host
that isn't deferred, are refused with a log line. GPUI's Linux clients stop
their event loop with the last window, so mirin's fork turns that off for a
deferred host (`gpui::set_quit_when_last_window_closes`, forks/gpui/MIRIN.md)
and the host quits itself on a real close. A host binary that does all this
names `MIRIN_METAL_RESIDENT` (the `RESIDENT_MARKER` const), as one that knows
deferred hosts names `MIRIN_METAL_DEFERRED`; a driver checks for it before it
hides, opens again, waits for `frame`, or sends `heightTransitionMs`
(Dashi's launcher stays resident this way). A consumer
that depends on `@mirinjs/metal` must share one React instance with it: a
`bun link` keeps the package's own `node_modules` (two Reacts, "Invalid hook
call"), so until it is published use `"@mirinjs/metal": "file:../path"`.

Or drive the host by hand:

```sh
echo '{"type":"view","props":{"fill":true,"center":true,"background":"#3b82f6"},"children":[{"type":"text","props":{"size":40,"color":"#ffffff"},"children":["mirin metal"]}]}' \
  | crates/mirin-metal/target/debug/mirin-metal-host
```
