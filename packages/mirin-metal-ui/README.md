# @mirinjs/metal-ui (alpha)

[shadcn/ui](https://ui.shadcn.com) for mirin metal. The same component names,
props, variants (`buttonVariants`, `cva`, `cn`), and theme tokens, rendered as
native GPU UI through `@mirinjs/metal` instead of the DOM. The goal is that an
app written against shadcn ports by changing imports, not components.

```tsx
import { Button, Card, CardContent, CardHeader, CardTitle, Input, ThemeProvider } from "@mirinjs/metal-ui";

<ThemeProvider>
  <Card className="w-[360px]">
    <CardHeader><CardTitle>Create project</CardTitle></CardHeader>
    <CardContent className="gap-3">
      <Input value={name} onChangeText={setName} placeholder="Name" />
      <Button onClick={deploy}>Deploy</Button>
    </CardContent>
  </Card>
</ThemeProvider>
```

## How it stays 1:1

- **`className` keeps working.** `tw()` translates the Tailwind utilities
  shadcn components use (flex, gap, padding, sizing, radii, borders, theme
  colors with `/alpha`, text size/weight/color, `hover:bg-*`, `absolute` +
  offsets) into Metal styles. Web-only utilities are ignored.
- **Theme tokens are the CSS variables.** `--background`, `--primary`,
  `--muted-foreground`, … are `ThemeTokens`; `darkTheme`/`lightTheme` ship the
  zinc defaults. Swap them through `ThemeProvider`.
- **`cva` and `cn`** have the shapes shadcn files expect, so variant tables
  copy verbatim.
- **Text inherits.** `text-*`/`font-*` on a container flow down to nested
  text, like CSS.

## What differs

- No DOM, no Radix: overlays (`Dialog`, `AlertDialog`, `Sheet`) render into the
  `ThemeProvider`'s overlay layer; `Popover`, `DropdownMenu`, `Select`, and
  `Tooltip` anchor under/over their trigger instead of using floating-ui.
- Inputs are controlled (`value` + `onChangeText` / `onChange`).
- Tables are flex rows with fixed cell widths (`width` on `TableHead`/`TableCell`).
- Icons: pass text glyphs or Metal `<Text>`; there is no SVG yet.
- `asChild` is accepted and ignored; triggers wrap their child.
- Not ported yet: `Sidebar`, `Resizable`, `Sonner`, `InputGroup`, `CodeBlock`.

## Run the gallery

```sh
cd crates/mirin-metal && cargo build --bin mirin-metal-host
cd packages/mirin-metal-ui && bun demo/gallery.tsx      # interactive
bun demo/check.ts                                        # drives it through simulated input
```
