# Fields: other text over a stretch, and room kept for a table (design, not built)

Status: design notes, 2026-11-17, branch `notes-asks`. Neither is built.
They are Notes' last two asks of `TextInput`
(`dashi-0.9.0-review/30-notesmd/for-mirin.md`, items 1 and 3); a run's
font family and Shift+Tab (items 2 and 4b) are built on the same branch.

Today Notes gives the field a *projection* of the note (its Markdown with
the markers taken out, `apps/notes/lib/project.ts`), maps every offset back
(`offsets.ts`), writes the clipboard itself, and keeps a table's room with
sized spaces under a table drawn beside the field. Both designs below let
the field hold the note's source and draw what it means.

## 1. `TextRun.replace`: a stretch drawn as other text

```tsx
<TextInput
  value={"## Plan\n- milk"}
  runs={[
    { start: 0, end: 3, replace: "" },  // "## " takes no room
    { start: 8, end: 9, replace: "•" }, // "-" drawn as a dot
  ]}
/>
```

The value is untouched: `onChangeText`, the selection, Copy and the
accessibility text all stay on the source. Only layout and drawing use
the replacement.

**Where it goes in the host.**

- `field.rs`'s `Display` already maps buffer chars to drawn bytes with one
  inserted range (an input method's composition at the caret:
  `inserted`, `buffer_char`, `byte_of`, `buffer_bytes`). That map becomes a
  sorted list of segments, each `(buffer chars, drawn chars)`: unchanged
  text, the composition, and each replaced stretch. The three functions
  walk it with a binary search; every caller (`runs.rs`, `caret.rs`,
  `marks.rs`, `selection.rs`) keeps working through them.
- `Field::display` builds the drawn text from the buffer and the
  replacements (sorted, overlaps dropped, the later run winning as runs do
  now), then puts the composition at the caret as today. A caret can never
  be inside a replaced stretch (below), so the two never meet.
- `runs::style` already styles by `buffer_bytes`, so a run over a replaced
  stretch styles its replacement: a bullet drawn in the marker's faded ink.

**The caret treats a replaced stretch as one thing.**

- `Field::move_to` (and so the arrows, Home/End, word steps and a click)
  snaps an offset strictly inside a stretch to its nearer edge: the one in
  the direction of travel for a key, the one nearer the pointer for a
  click (`caret.rs` knows the x of both edges).
- Backspace at a stretch's end, or Delete at its start, removes the whole
  stretch: the person cannot see its characters, so removing one of them
  would change something they cannot see. Notes shows a block's source
  while the caret is in it, so in practice this only meets a stretch at a
  block's edge.
- A selection may cover stretches; it is washed over their replacements,
  and Copy gives the source.
- `replace: ""` draws nothing and takes no room: the caret at both edges
  is drawn at the same x.

**Wire and trust.** `InputRun.replace: Option<String>`, at most 64 chars
(the driver is a trust boundary; longer is cut). `InputRun` denies unknown
fields, so a host from before refuses the whole tree: the host names
`MIRIN_METAL_RUN_REPLACE` and says `"runReplace":true` in its `protocol`
line, and an app sends `replace` only to a host that has it, as it does
for `opaque`.

**Accessibility.** The field's AT-SPI `Text` (branch `fields-text`)
publishes the value, so a screen reader hears "## Plan". That is what
`value` holds and what an agent's `fill_element` writes; it is the right
default. If Notes wants the drawn words read, a later `accessibleValue`
can say so; not part of this.

**Tests.** `field/tests`: the display map with a composition next to a
stretch; arrows and a click snapping; Backspace removing a stretch whole;
Copy of a selection over a stretch giving the source. `render/` on GPUI's
test platform: a heading whose `## ` is replaced by nothing lays out at the
words' width.

## 2. `TextInput.blocks`: room kept for what the app draws

```tsx
<TextInput
  value={md}
  blocks={[{ start: 120, end: 260, height: 96 }]}
  onBlockLayout={({ index, x, y, width, height }) => placeTable(index, x, y, width)}
/>
```

The paragraphs from `start` to `end` (widened to whole paragraphs) are laid
out as one line `height` px tall that draws nothing, and the field reports
where it put each block after layout. Notes draws the table there, over
the field, at the exact place: no sized spaces, no second copy of the text
that must wrap like the field's.

**Where it goes.**

- It is a replaced stretch (section 1) with `replace: ""` over the
  paragraphs, plus a height for the one line that is left. sumi's
  `StyledText` already lays out paragraphs at their own sizes and keeps
  each line's own height (`with_paragraph_sizes`, `line_heights` in
  `TextLayoutInner`); a block is a paragraph with an empty line of a given
  height. `with_paragraph_heights(Vec<Option<Pixels>>)` beside
  `with_paragraph_sizes`, in the same `// mirin:` code.
- The caret steps over a block as over any stretch; Up and Down from the
  line above or below go to the line past it.
- `onBlockLayout` is reported as `layout` events are (`render.rs`'s
  `record_child_bounds`), in the field's coordinates, only when a block's
  rect changed, with the block's index.
- The field's scroll content height includes the blocks (they are lines),
  so a long note with tables scrolls to its end.

**Why after section 1:** a block needs the caret to treat its source as one
thing, which is exactly what `replace` builds.

## What Notes would drop

- `project.ts` and `offsets.ts` (the projection and its offset map), with
  the stale-caret race they bring (a caret report for a text Notes has
  already replaced).
- Its own Copy through wl-copy: the field's Copy gives the source.
- The table's sized spaces and the mirrored text under the field.
