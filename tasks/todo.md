# Metal + Linux (Fedora) tracks

Started 2026-10-29 on branch `feat/metal-linux`. Two parallel tracks; each item
names its acceptance check. Checkpoint notes go at the bottom.

## Track A — Linux support, Fedora first

- [x] A0 Fedora dev box bootstrapped: dnf deps, rustup, `vendor/cef` fetched
      (recorded in `docs/linux-port.md` → Fedora).
- [x] A1 `mirin check` on `examples/hello-react` passes on Fedora/KDE Wayland
      (XWayland path). Accept: exit 0, screenshot + UI snapshot in `.mirin/dev/`.
- [ ] A2 `mirin doctor` grows Linux checks: cmake, ninja, gcc-c++, Vulkan
      loader, GTK3 runtime, and a dnf hint when a check fails on an rpm-based
      distro. Accept: `mirin doctor --json` lists them; unit test for the
      hint mapping.
- [ ] A3 `scripts/fetch-cef.ts` reports a clear fix when `cargo` is missing
      from `PATH` (point at `~/.cargo/bin`).
- [~] A4 L4 app-shell gaps from `docs/linux-port.md`: dialogs ✅ (portal +
      zenity/kdialog), page downloads ✅, window geometry/frame/focus ✅;
      still open: clipboard, context menus, tray (StatusNotifierItem), global
      shortcuts (portal), deep links (`.desktop` MIME). Verify with
      `examples/kitchen-sink` on Fedora.
- [x] A5 `mirin build --linux-target rpm,deb` on Fedora through fpm (user gem
      install lands in `~/bin`); Anko's rpm installs and launches from
      `/usr/bin/anko` with its desktop entry. AppImage still needs appimagetool.
- [ ] A6 Wayland-native CEF investigation stays closed unless CEF gains
      client-side decorations (see `docs/linux-port.md` rationale).

## Track B — Metal (`@mirinjs/metal` + `crates/mirin-metal`)

- [x] B0 Alpha imported and renamed; builds standalone on Fedora; tests, fmt,
      clippy, biome, tsc pass; stdio demo renders on Wayland and X11.
- [ ] B1 Decide process model + packaging (`docs/metal.md` §3 questions).
      Owner sign-off required.
- [~] B2 `TextInput` (buffer, caret, paste, Tab cycling, change/submit),
      `ScrollView`, hover, borders, opacity, alignment, truncation, mono ✅;
      Anko's `apps/metal` runs on it. Still open: real-click press check,
      `Image`, text selection, absolute positioning.
- [x] B2b Simulation channel (`sim` commands, layout query, `testID`,
      `root.lastTree()`), used by Anko's `apps/metal/check.ts` and the
      metal-ui gallery check. Hover simulation is still missing.
- [x] B7 `@mirinjs/metal-ui`: shadcn/ui ported 1:1 (30 components, theme
      tokens, Tailwind translator, overlay layer). Open: Sidebar, Resizable,
      Sonner, InputGroup, CodeBlock, icons/images, floating-ui style
      positioning, hover-driven tooltip check.
- [ ] B3 Tree patch protocol (insert/remove/update by node id) replacing
      whole-tree replacement; reconciler emits patches from mutation methods.
- [ ] B4 `libmirin_metal` C ABI + polled event queue; Bun host boots it like
      `libmirin_core`; `docs/architecture.md` gains the Metal arm.
- [ ] B5 `mirin dev` / `build` for a Metal example (`examples/metal-counter`),
      Linux first.
- [ ] B6 Bump GPUI when its tar fork drops `xattr 0.2`; remove the `libc`
      pin.

## Checkpoints

- 2026-10-29 (day 2): Anko Metal is a working SQL client (connection form for
  SQLite/PostgreSQL/MySQL, schema tree with columns, tabs, history, saved
  queries, paginated results with row details) verified by an in-process check
  over the new simulation channel, including a PostgreSQL container run.
  `@mirinjs/metal-ui` lands with a gallery check. Lesson: never send ydotool
  input while the owner is at the machine; the simulation channel exists so
  checks never touch the desktop.

- 2026-10-29 (night): Anko works on Linux end to end (dev, check scenario,
  standalone build, rpm installed from /usr/bin) and a first Anko on Metal
  (`apps/metal`) connects to SQLite and renders query results through GPUI.

- 2026-10-29: Both tracks bootstrapped. `mirin-metal-host` draws piped trees on
  KDE Wayland (RADV) and under XWayland. Lesson: when smoke-testing GUI hosts
  from a shell, give every run its own log file and kill leftovers by `pidof`,
  not `pkill -f` (which matches the invoking shell).
