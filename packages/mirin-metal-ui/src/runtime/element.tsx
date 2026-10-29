/**
 * Intrinsic HTML elements for the JSX runtime: `<div>`, `<input>`, `<img>`,
 * `<svg>`, … each map to a Metal-backed implementation. Tags with no desktop
 * meaning (`<script>`, `<iframe>`) render nothing.
 */

import type { ReactNode } from "react";
import { Box, type BoxProps } from "./box.tsx";
import { HtmlInput, HtmlSelect, HtmlTextarea } from "./controls.tsx";
import { HtmlHr, HtmlImage, HtmlSvg } from "./media.tsx";
import { HtmlCell, HtmlRow, HtmlTable } from "./table.tsx";

const NULL_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "video",
  "audio",
  "canvas",
  "noscript",
  "source",
  "track",
  "meta",
  "link",
  "head",
  "title",
  "template",
  "colgroup",
  "col",
  "datalist",
  "defs",
  "option",
  "optgroup",
  "object",
  "embed",
]);

export type ElementProps = BoxProps & { __tag: string };

type Intrinsic = (props: ElementProps) => ReactNode;

function Nothing(): ReactNode {
  return null;
}

function LineBreak(): ReactNode {
  return <Box tag="br" viewStyle={{ width: "100%", height: 0 }} />;
}

const SPECIAL: Record<string, Intrinsic> = {
  input: HtmlInput,
  textarea: HtmlTextarea,
  select: HtmlSelect,
  img: HtmlImage,
  svg: HtmlSvg,
  hr: HtmlHr,
  table: HtmlTable,
  tr: HtmlRow,
  th: HtmlCell,
  td: HtmlCell,
  br: LineBreak,
};

/**
 * The component an intrinsic tag renders as, resolved when the JSX element is
 * created so each HTML element costs one component, not a router plus Box.
 */
export function intrinsicComponent(tag: string): Intrinsic {
  if (NULL_TAGS.has(tag)) return Nothing;
  return SPECIAL[tag] ?? (Box as Intrinsic);
}

export function Element(props: ElementProps): ReactNode {
  const tag = props.__tag;
  if (NULL_TAGS.has(tag)) return null;
  switch (tag) {
    case "input":
      return <HtmlInput {...props} />;
    case "textarea":
      return <HtmlTextarea {...props} />;
    case "select":
      return <HtmlSelect {...props} />;
    case "img":
      return <HtmlImage {...props} />;
    case "svg":
      return <HtmlSvg {...props} />;
    case "hr":
      return <HtmlHr {...props} />;
    case "table":
      return <HtmlTable {...props} />;
    case "tr":
      return <HtmlRow {...props} />;
    case "th":
    case "td":
      return <HtmlCell {...props} />;
    case "br":
      return <Box tag="br" viewStyle={{ width: "100%", height: 0 }} />;
    default:
      return <Box {...props} tag={tag} />;
  }
}
