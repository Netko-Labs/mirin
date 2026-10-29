/**
 * `Box`: the generic HTML element. Every `<div>`, `<p>`, `<span>`, `<button>`,
 * `<li>`… renders through here: its Tailwind classes are translated against
 * its own attributes and ancestor groups, text styling flows down like CSS
 * inheritance, inline content wraps, `grid-cols-N` lays out rows, and DOM
 * handlers (`onClick`, `onMouseEnter`, …) receive DOM-shaped events.
 */

import { Text, type TextStyle, View, type ViewStyle } from "@mirinjs/metal";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useContext,
  useMemo,
} from "react";
import { cn } from "../lib/cn.ts";
import { useTheme } from "../theme.ts";
import { type TwStyle, translate } from "../tw/index.ts";
import type { Attrs } from "../tw/variants.ts";
import {
  FormContext,
  GroupContext,
  type Inherited,
  InheritedContext,
  transformText,
  useInherited,
} from "./context.ts";
import { cssToMetal } from "./css.ts";
import { syntheticEvent } from "./events.ts";
import { openExternal } from "./open.ts";

/** Tags that flow inline (text runs) rather than stacking as blocks. */
export const INLINE_TAGS = new Set([
  "span",
  "a",
  "strong",
  "b",
  "em",
  "i",
  "small",
  "code",
  "kbd",
  "abbr",
  "time",
  "sup",
  "sub",
  "label",
  "mark",
  "s",
  "u",
  "del",
  "ins",
  "q",
  "cite",
  "var",
  "samp",
  "bdi",
  "img",
  "svg",
  "button",
  "input",
  "select",
]);

/** User-agent styles that survive Tailwind's preflight. */
const TAG_CLASSES: Record<string, string> = {
  strong: "font-bold",
  b: "font-bold",
  em: "italic",
  i: "italic",
  code: "font-mono",
  kbd: "font-mono",
  samp: "font-mono",
  pre: "font-mono",
  s: "line-through",
  del: "line-through",
  u: "underline",
  ins: "underline",
  small: "text-xs",
  sup: "text-xs",
  sub: "text-xs",
  th: "font-medium",
  table: "flex flex-col",
  thead: "flex flex-col",
  tbody: "flex flex-col",
  tfoot: "flex flex-col",
  tr: "flex flex-row",
  td: "flex-1",
};

/** Text properties that inherit, like CSS. */
const INHERITED_TEXT: Array<keyof TextStyle> = [
  "color",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "fontStyle",
  "textDecorationLine",
  "lineHeight",
  "textAlign",
];

export interface BoxProps {
  /** The HTML tag this box stands for (`div` by default). */
  tag?: string;
  className?: string;
  /** React DOM style object (sizes, colors). */
  style?: Record<string, unknown>;
  /** Metal-native style overrides applied last. */
  viewStyle?: ViewStyle;
  children?: ReactNode;
  ref?: Ref<unknown>;
  testID?: string;
  occlude?: boolean;
  onLayout?: (bounds: { x: number; y: number; width: number; height: number }) => void;
  onClick?: (event: ReturnType<typeof syntheticEvent>) => void;
  onMouseDown?: (event: ReturnType<typeof syntheticEvent>) => void;
  onMouseEnter?: (event: ReturnType<typeof syntheticEvent>) => void;
  onMouseLeave?: (event: ReturnType<typeof syntheticEvent>) => void;
  onContextMenu?: (event: ReturnType<typeof syntheticEvent>) => void;
  onPointerDown?: (event: ReturnType<typeof syntheticEvent>) => void;
  onPointerMove?: (event: ReturnType<typeof syntheticEvent>) => void;
  onPointerUp?: (event: ReturnType<typeof syntheticEvent>) => void;
  onSubmit?: (event: ReturnType<typeof syntheticEvent>) => void;
  [attr: string]: unknown;
}

/** `data-*`, `aria-*`, and the boolean states variants test. */
export function collectAttrs(props: Record<string, unknown>): Attrs {
  const attrs: Attrs = {};
  for (const [key, value] of Object.entries(props)) {
    if (
      key.startsWith("data-") ||
      key.startsWith("aria-") ||
      key === "disabled" ||
      key === "checked" ||
      key === "open" ||
      key === "role"
    ) {
      attrs[key] = value;
    }
  }
  return attrs;
}

function attrsKey(attrs: Attrs): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("|");
}

function isText(node: ReactNode): node is string | number {
  return typeof node === "string" || typeof node === "number";
}

function tagOf(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined;
  const props = node.props as { __tag?: unknown };
  return typeof props.__tag === "string" ? props.__tag : undefined;
}

function isInlineNode(node: ReactNode): boolean {
  if (isText(node)) return true;
  const tag = tagOf(node);
  if (tag) return INLINE_TAGS.has(tag);
  // Icons and other leaf components behave inline.
  return isValidElement(node) && (node.type as { inline?: boolean }).inline === true;
}

function pickInherited(text: TextStyle): TextStyle {
  const out: TextStyle = {};
  for (const key of INHERITED_TEXT) {
    const value = text[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** A run of text with the inherited style. */
export function TextRun({
  children,
  style,
  truncate,
}: {
  children: string;
  style?: TextStyle;
  truncate?: boolean;
}) {
  const inherited = useInherited();
  return (
    <Text numberOfLines={truncate ? 1 : undefined} style={{ ...inherited.text, ...style }}>
      {transformText(children, inherited.transform)}
    </Text>
  );
}

/** `col-span-N` of a grid child, read from its className. */
function spanOf(node: ReactNode, columns: number): number {
  if (!isValidElement(node)) return 1;
  const className = (node.props as { className?: unknown }).className;
  if (typeof className !== "string") return 1;
  if (/(^|\s)col-span-full(\s|$)/.test(className)) return columns;
  const match = className.match(/(?:^|\s)(?:\w+:)?col-span-(\d+)(?:\s|$)/);
  return match ? Math.min(columns, Number(match[1])) : 1;
}

function gridRows(items: ReactNode[], columns: number, gap: number | undefined): ReactNode[] {
  const rows: ReactNode[][] = [];
  let row: ReactNode[] = [];
  let used = 0;
  items.forEach((item, index) => {
    const span = spanOf(item, columns);
    if (used + span > columns && row.length > 0) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(
      <View key={`cell-${index}`} style={{ flex: span, minWidth: 0, flexDirection: "column" }}>
        {item}
      </View>,
    );
    used += span;
  });
  if (row.length > 0) rows.push(row);
  return rows.map((cells, index) => {
    const filler = columns - cells.length;
    return (
      <View key={`row-${index}`} style={{ flexDirection: "row", gap, alignItems: "stretch" }}>
        {cells}
        {filler > 0 && cells.length < columns
          ? Array.from({ length: filler }, (_, i) => <View key={`pad-${i}`} style={{ flex: 1 }} />)
          : null}
      </View>
    );
  });
}

function renderChildren(
  items: ReactNode[],
  tw: TwStyle,
  list: "disc" | "decimal" | undefined,
): ReactNode[] {
  return items.map((item, index) => {
    if (isText(item)) {
      return (
        <TextRun key={`t${index}`} truncate={tw.truncate}>
          {String(item)}
        </TextRun>
      );
    }
    if (list && tagOf(item) === "li") {
      const marker = list === "disc" ? "•" : `${index + 1}.`;
      return (
        <View key={`li${index}`} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
          <TextRun>{marker}</TextRun>
          <View style={{ flex: 1, flexDirection: "column" }}>{item}</View>
        </View>
      );
    }
    return item;
  });
}

export function Box(props: BoxProps): ReactNode {
  const {
    tag = "div",
    className,
    style,
    viewStyle,
    children,
    ref,
    testID,
    occlude,
    onLayout,
    onClick,
    onMouseDown,
    onMouseEnter,
    onMouseLeave,
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onSubmit,
  } = props;
  const theme = useTheme();
  const inherited = useInherited();
  const groups = useContext(GroupContext);
  const form = useContext(FormContext);
  const attrs = collectAttrs(props);
  const stateKey = attrsKey(attrs);

  // biome-ignore lint/correctness/useExhaustiveDependencies: stateKey summarizes attrs
  const tw = useMemo(
    () =>
      translate(cn(TAG_CLASSES[tag], className), theme.colors, theme.radius, {
        attrs,
        groups,
        dark: theme.mode === "dark",
        viewportWidth: theme.viewportWidth,
      }),
    // attrs is summarized by stateKey.
    [tag, className, theme, stateKey, groups],
  );
  if (tw.hidden || tw.display === "none") return null;

  const css = cssToMetal(style);
  const ownText = { ...tw.text, ...css.text };
  const nextInherited: Inherited = {
    text: { ...inherited.text, ...pickInherited(ownText) },
    transform: tw.textTransform ?? inherited.transform,
    svg: {
      size: tw.svg.size ?? inherited.svg.size,
      color: tw.svg.color ?? inherited.svg.color,
    },
  };
  const textChanged =
    Object.keys(ownText).length > 0 ||
    tw.textTransform !== undefined ||
    tw.svg.size !== undefined ||
    tw.svg.color !== undefined;

  const items = Children.toArray(children).filter((item) => item !== "" && item !== null);
  const isInlineTag = INLINE_TAGS.has(tag);
  const display = tw.display ?? (isInlineTag ? "inline" : "block");
  const textOnly = items.length > 0 && items.every(isText);
  const inlineFlow = !textOnly && items.length > 1 && items.every(isInlineNode);

  const view: ViewStyle = { ...tw.view, ...css.view };
  let direction: "row" | "column";
  if (display === "flex" || display === "inline-flex") direction = tw.direction ?? "row";
  else if (display === "grid" || display === "inline-grid") direction = "column";
  else if (display === "inline" || display === "inline-block") direction = "row";
  else direction = inlineFlow ? "row" : (tw.direction ?? "column");
  view.flexDirection = direction;
  if (inlineFlow && display !== "flex" && display !== "inline-flex") {
    view.flexWrap = "wrap";
    view.alignItems = view.alignItems ?? "center";
    if (ownText.textAlign === "center") view.justifyContent = "center";
  }
  if (view.gap === undefined) {
    if (direction === "column" && tw.spaceY !== undefined) view.gap = tw.spaceY;
    if (direction === "row" && tw.spaceX !== undefined) view.gap = tw.spaceX;
  }
  if (isInlineTag && display === "inline") view.alignItems = view.alignItems ?? "center";

  const disabled = attrs.disabled === true || attrs["aria-disabled"] === "true";
  const interactive = !tw.pointerEventsNone && !disabled;
  const isSubmit = tag === "button" && form !== null && props.type !== "button";
  const href = typeof props.href === "string" ? props.href : undefined;
  const pressable = interactive && (onClick || onMouseDown || isSubmit || (tag === "a" && href));

  const listStyle = tag === "ul" || tag === "ol" ? tw.listStyle : undefined;
  let body: ReactNode[];
  if (textOnly) {
    body = [
      <TextRun key="text" truncate={tw.truncate}>
        {items.map(String).join("")}
      </TextRun>,
    ];
  } else if ((display === "grid" || display === "inline-grid") && (tw.gridCols ?? 1) > 1) {
    body = gridRows(renderChildren(items, tw, undefined), tw.gridCols ?? 1, view.gap);
  } else {
    body = renderChildren(items, tw, listStyle);
  }

  const element: ReactElement = (
    <View
      ref={ref as never}
      testID={
        testID ??
        (typeof props["data-testid"] === "string" ? props["data-testid"] : undefined) ??
        (typeof props["data-slot"] === "string" ? props["data-slot"] : undefined)
      }
      occlude={occlude}
      onLayout={onLayout}
      style={{ ...view, ...viewStyle }}
      onPress={
        pressable
          ? ({ bounds }) => {
              const event = syntheticEvent("click", { bounds });
              onMouseDown?.(event);
              onClick?.(event);
              if (!event.defaultPrevented && isSubmit) form?.submit();
              if (!event.defaultPrevented && tag === "a" && href && !onClick) openExternal(href);
            }
          : undefined
      }
      onHoverChange={
        interactive && (onMouseEnter || onMouseLeave)
          ? (hovered, bounds) => {
              const event = syntheticEvent(hovered ? "mouseenter" : "mouseleave", { bounds });
              (hovered ? onMouseEnter : onMouseLeave)?.(event);
            }
          : undefined
      }
      onContextMenu={
        interactive && onContextMenu
          ? ({ x, y }) => onContextMenu(syntheticEvent("contextmenu", { x, y }))
          : undefined
      }
      onPointer={
        interactive && (onPointerDown || onPointerMove || onPointerUp)
          ? (info) => {
              const event = syntheticEvent(`pointer${info.phase}`, {
                x: info.x,
                y: info.y,
                bounds: info.bounds,
              });
              if (info.phase === "down") onPointerDown?.(event);
              else if (info.phase === "move") onPointerMove?.(event);
              else onPointerUp?.(event);
            }
          : undefined
      }
    >
      {body}
    </View>
  );

  let wrapped: ReactNode = element;
  if (tag === "form") {
    const submit = () => onSubmit?.(syntheticEvent("submit"));
    wrapped = (
      <FormContext.Provider value={{ submit, reset: () => {} }}>{wrapped}</FormContext.Provider>
    );
  }
  if (tw.group !== undefined) {
    wrapped = (
      <GroupContext.Provider value={{ ...groups, [tw.group]: attrs }}>
        {wrapped}
      </GroupContext.Provider>
    );
  }
  if (textChanged) {
    wrapped = (
      <InheritedContext.Provider value={nextInherited}>{wrapped}</InheritedContext.Provider>
    );
  }
  return wrapped;
}
