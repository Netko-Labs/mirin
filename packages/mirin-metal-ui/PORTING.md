# Porting shadcn/ui to metal-ui

metal-ui renders shadcn's own source on Metal (GPUI, no DOM). The goal is
1:1: upstream component files and examples keep their markup, props, and
class strings; only imports change.

Upstream reference: shadcn `main`, `apps/v4/registry/new-york-v4/{ui,examples,hooks}`
(sparse clone at `/tmp/shadcn-src/ui`).

## How it works

- **JSX runtime.** `tsconfig.json` sets `"jsxImportSource": "@mirinjs/metal-ui"`.
  Lowercase tags (`<div>`, `<p>`, `<button>`, `<input>`, `<img>`, `<svg>`) render
  through `src/runtime/` (`Box`, controls, media). Components are normal React.
- **Tailwind engine** (`src/tw/`). Class strings translate to Metal styles.
  Variants are evaluated against the element's own props: `data-[state=open]:`,
  `data-disabled:`, `aria-invalid:`, `disabled:`, `group-data-[x=y]/name:`
  (ancestor with `group/name`), `dark:`, `sm:`/`md:`/`lg:`. `hover:`, `focus:`,
  and `data-[highlighted]:` all map to hover (only `bg-*` is applied on hover).
  `[&_svg]:size-4` / `[&_svg:not(...)]:text-…` / `*:[svg]:…` set descendant icon
  defaults. Transitions, rings, outlines, z-index, transforms, and animations
  are ignored on purpose.
- **Layout semantics.** `flex` → row unless `flex-col`; block elements stack
  as columns; a block whose children are all inline (text, `span`, `a`,
  `strong`, `code`, `button`, icons) wraps as an inline row; `grid` +
  `grid-cols-N` (and `col-span-N`) lays out rows of N; `space-y-*`/`space-x-*`
  become gaps; text styles inherit like CSS.
- **Primitives** (`src/primitives/<name>.tsx`) replace Radix with the same
  namespace and part names (`Dialog.Root`, `Dialog.Trigger`, …). The port
  script rewrites `import { X as XPrimitive } from "radix-ui"` to
  `../primitives/<kebab-of-X>.tsx` (except `DropdownMenu` → `menu.tsx`,
  `AlertDialog` → `dialog.tsx`). Each file exports `export const X = { Root, … }`.
- **Overlays** go through `src/overlay/`: `Portal` (React portal into the
  window-wide layer, context preserved), `DismissLayer` (full-window,
  occluding, press = dismiss), and `Popper` (anchors to a `Bounds`, measures
  itself, flips/shifts to stay in the window). Get the trigger rect with
  `boundsOf(event)` from an `onClick` (DOM-shaped event).
  `registerOverlayChild(Component)` mounts a component in every overlay host
  (sonner's fallback `<Toaster />`, so `toast()` works with no Toaster mounted).
- **Third-party packages** are remapped by `scripts/port-ui.ts` (`MODULES`):
  `sonner` → `components/sonner.tsx`, `recharts` → `charts/index.ts`,
  `cmdk`/`vaul`/`input-otp`/`react-resizable-panels`/`embla-carousel-*`/
  `@base-ui/react` → `primitives/*`, `next/*`, `next-themes`, `@tabler/icons-react`,
  `react-day-picker` → `compat/*`, `@/hooks/*` → `hooks/*`. Headless libraries
  that work in any React renderer are real dependencies: `date-fns`, `zod`,
  `react-hook-form`, `@hookform/resolvers`, `@tanstack/react-form`,
  `@tanstack/react-table`, `@formisch/react`, `valibot`.

## Porting a component

```sh
R=/tmp/shadcn-src/ui/apps/v4/registry/new-york-v4
bun scripts/port-ui.ts $R ui accordion          # → src/components/accordion.tsx
bun scripts/port-ui.ts $R examples accordion-demo   # → demo/examples/accordion-demo.tsx
```

1. Port the ui file with the script. Do not hand-edit class strings unless a
   construct cannot work on Metal; when you must, keep the change minimal and
   leave a one-line `// metal:` comment saying why.
2. Write the primitive it needs in `src/primitives/<name>.tsx`, modeled on
   `dialog.tsx`, `popover.tsx`, and `menu.tsx`: radix part names and props,
   `useControllableState` for open/value, `Slot` for `asChild`, `data-state`
   (and other `data-*`/`aria-*`) attributes on the rendered elements so the
   upstream variants apply, `occlude` on anything that floats.
3. Port every example for that component and run them.

## Primitive conventions

- Props are typed loosely (`Record<string, unknown>` plus the named props);
  spread merged props objects typed as `Props` into intrinsic tags.
- Render intrinsic tags (`<div>`, `<button>`), never Metal `View`, unless you
  need Metal-only features (absolute positioning containers, `occlude`,
  `onLayout`).
- Handlers receive `SyntheticEvent` (`src/runtime/events.ts`): `preventDefault`,
  `target.value`, `target.checked`, `target.getBoundingClientRect()`.
- Drag (sliders, resize handles): `onPointerDown`/`onPointerMove`/`onPointerUp`
  on an intrinsic element; the event has `clientX/clientY` and the element's
  rect via `target.getBoundingClientRect()`. Moves and the release keep
  arriving after the pointer leaves the element.
- Hover: `onMouseEnter`/`onMouseLeave`. Right-click: `onContextMenu` (has
  `clientX/clientY`).
- Keyboard: there is no global key handling yet; Escape does not close
  overlays. Inputs submit on Enter (`onKeyDown` gets `key: "Enter"`).

## Visual review (off-screen)

`bun bench/shot.tsx --out /tmp/shots <example…> > /dev/null` renders examples
in a private virtual compositor and saves screenshots, so layouts can be
checked against shadcn without opening windows on the desktop.

## Testing (headless, no windows)

Never open native windows or send desktop input (ydotool) while porting: the
machine is in use. Test headlessly:

```sh
bun test test/examples.test.tsx -t accordion   # mounts each matching example
bun test test/foundation.test.tsx              # harness usage examples
bunx tsc --noEmit -p .                         # filter output to your files
bunx biome check --write <your files>
```

`test/harness.ts` mounts a tree on a fake transport and exposes `tree()`,
`texts()`, `hasText()`, `press(testID)`, `pressText(text)`, `type(testID, v)`,
`hover(testID, bool)`. `data-slot`/`data-testid`/`testID` all work as test
IDs. Add behavior tests for interactive primitives in
`test/<component>.test.tsx`.

## Ownership

Parallel workers own disjoint files (their components, primitives, compat
modules, examples, and tests). Do not edit `src/index.ts`,
`src/primitives/index.ts`, or another group's components.

The shared engine (`src/tw/*`, `src/runtime/*`, `src/overlay/*`,
`scripts/port-ui.ts`) may take small, additive fixes when a port needs them
(a missing Tailwind utility, a variant, an intrinsic tag). Other workers edit
the same files concurrently: re-read right before each edit, change only the
lines you need, never reformat or reorder, and list every engine change in
your final report. Do not commit; the coordinator commits.
