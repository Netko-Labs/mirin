# @mirinjs/metal-ui (alpha)

[shadcn/ui](https://ui.shadcn.com) for mirin metal. Every component and every
example from shadcn `main` (`apps/v4/registry/new-york-v4`) is ported with its
markup, props, variants, and `className` strings unchanged; only imports
differ. They render as native GPU UI through `@mirinjs/metal`, with no DOM.

```tsx
// tsconfig.json: "jsx": "react-jsx", "jsxImportSource": "@mirinjs/metal-ui"
import { Button, Card, CardContent, CardHeader, CardTitle, Input, ThemeProvider } from "@mirinjs/metal-ui";

<ThemeProvider>
  <Card className="w-[360px]">
    <CardHeader><CardTitle>Create project</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-3">
      <Input placeholder="Name" />
      <Button onClick={deploy}>Deploy</Button>
    </CardContent>
  </Card>
</ThemeProvider>
```

## Entry points

| Import | Contents |
| --- | --- |
| `@mirinjs/metal-ui` | every component, `cn`/`cva`, `ThemeProvider`, themes, `tw()` |
| `@mirinjs/metal-ui/icons` | all lucide icons under their `lucide-react` names; an icon reads its data when it first renders |
| `@mirinjs/metal-ui/primitives` | Radix-compatible namespaces (`Dialog.Root`, …) |
| `@mirinjs/metal-ui/charts` | the recharts subset the chart component uses |
| `@mirinjs/metal-ui/jsx-runtime` | the JSX runtime that renders `<div>`, `<button>`, `<input>`, `<svg>`, … |

## How it works

- **JSX runtime.** Lowercase tags render through metal-ui's runtime, so
  upstream files keep writing `<div className="…">`.
- **Tailwind engine.** Class strings translate to Metal styles at render time,
  once per class string, theme and variant outcome (`src/tw/cache.ts`).
  Variants (`data-[state=open]:`, `aria-invalid:`, `group-data-*`, `dark:`,
  `sm:`/`md:`/`lg:`, `first:`/`last:`) evaluate against the element's own
  attributes, and CSS custom properties (`--sidebar-width`, `size-(--cell-size)`)
  resolve through the tree.
- **Primitives** replace Radix, cmdk, vaul, sonner, embla, input-otp,
  react-resizable-panels, react-day-picker, and Base UI with the same part
  names and props. Headless libraries (react-hook-form, TanStack Form and
  Table, formisch, zod, valibot, date-fns) are real dependencies.
- **Themes.** All 24 shadcn themes are generated from their oklch tokens.

See [PORTING.md](./PORTING.md) for the method and the list of conventions.

## What differs from the web

- No keyboard navigation yet; Escape does not close overlays.
- No transforms or animations: tooltip arrows and accordion chevrons stay
  still, carousels jump between slides, and drawers have no drag-to-dismiss.
- One radius per element, so `rounded-l-*` rounds all corners.
- Unsupported selectors are ignored: `peer-*`, `even:`/`odd:`, descendant
  forms like `[&_tr:last-child]`. `has-*` works for tags, attributes,
  `:checked`/`:disabled`, and direct children (`>`).
- Charts: bar charts only. Toasts don't stack or swipe.

## Run the example browser

```sh
cd crates/mirin-metal && cargo build --bin mirin-metal-host
cd packages/mirin-metal-ui && bun demo/browser.tsx              # every example
bun demo/browser.tsx calendar-demo                             # open one example
bun test                                                        # headless checks
bun bench/shot.tsx --out /tmp/shots card-demo > /dev/null       # off-screen screenshots
bun bench/native.tsx                                            # off-screen benchmark
```
