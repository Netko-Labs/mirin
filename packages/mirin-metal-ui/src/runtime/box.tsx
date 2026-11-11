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
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useContext,
  useMemo,
} from "react";
import { cn } from "../lib/cn.ts";
import { useStyleTheme } from "../theme.ts";
import { styleFor, type TwStyle } from "../tw/index.ts";
import type { Attrs } from "../tw/variants.ts";
import {
  FormContext,
  GroupContext,
  type Inherited,
  InheritedContext,
  SiblingContext,
  type SiblingPosition,
  transformText,
  useInherited,
} from "./context.ts";
import { cssToMetal } from "./css.ts";
import { syntheticEvent } from "./events.ts";
import { type FormHandle, FormScope, resolveForm } from "./form.tsx";
import { HasContext, useHasOwner, useHasRegistration } from "./has.ts";
import { openExternal } from "./open.ts";
import { ownVars, readsVars, substituteVars, VarsContext } from "./vars.ts";

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
  th: "flex-1 font-medium",
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
  /**
   * Metal-only: acts as a title bar (a press moves the window, a double click
   * zooms it); buttons and inputs inside keep their clicks. For the toolbar of
   * a window opened with `titleBar: "unified"`. In JSX on a DOM tag, write the
   * `data-drag-region` attribute (React's DOM types have no `dragRegion`).
   */
  dragRegion?: boolean;
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
  // A plain loop: this runs for every element of every render.
  for (const key in props) {
    if (
      key.startsWith("data-") ||
      key.startsWith("aria-") ||
      key === "disabled" ||
      key === "checked" ||
      key === "open" ||
      key === "role"
    ) {
      attrs[key] = props[key];
    }
  }
  return attrs;
}

function attrsKey(attrs: Attrs): string {
  let key = "";
  for (const name in attrs) {
    key = `${key}${key === "" ? "" : "|"}${name}=${String(attrs[name])}`;
  }
  return key;
}

/** `Children.toArray`, with fragments spread in place (`<>{label}</>` is its text). */
function flattenFragments(children: ReactNode, prefix = ""): ReactNode[] {
  return Children.toArray(children).flatMap((item) => {
    if (isValidElement(item) && item.type === Fragment) {
      const inner = (item.props as { children?: ReactNode }).children;
      return flattenFragments(inner, `${prefix}${String(item.key)}/`);
    }
    if (prefix && isValidElement(item))
      return [cloneElement(item, { key: `${prefix}${item.key}` })];
    return [item];
  });
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

const POSITIONS: SiblingPosition[] = [
  { first: true, last: true },
  { first: true, last: false },
  { first: false, last: true },
  { first: false, last: false },
];

/** Tell each child element whether it is first/last (`first:`/`last:` variants). */
function withSiblingPositions(nodes: ReactNode[]): ReactNode[] {
  const last = nodes.length - 1;
  return nodes.map((node, index) => {
    if (!isValidElement(node)) return node;
    const position = POSITIONS[(index === 0 ? 0 : 2) + (index === last ? 0 : 1)];
    return (
      <SiblingContext.Provider key={node.key ?? `s${index}`} value={position ?? null}>
        {node}
      </SiblingContext.Provider>
    );
  });
}

export function Box(props: BoxProps): ReactNode {
  const {
    tag = (props as { __tag?: string }).__tag ?? "div",
    className,
    style,
    viewStyle,
    children,
    ref,
    testID,
    occlude,
    dragRegion,
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
  const theme = useStyleTheme();
  const inherited = useInherited();
  const groups = useContext(GroupContext);
  const form = useContext(FormContext);
  const vars = useContext(VarsContext);
  const definedVars = ownVars(className, style, vars, theme.colors);
  const scopeVars = definedVars ? { ...vars, ...definedVars } : vars;
  const classes = readsVars(className)
    ? substituteVars(className ?? "", scopeVars, theme.colors)
    : className;
  const attrs = collectAttrs(props);
  const sibling = useContext(SiblingContext);
  if (sibling) {
    attrs["data-metal-first"] ??= sibling.first;
    attrs["data-metal-last"] ??= sibling.last;
  }
  const stateKey = attrsKey(attrs);
  const usesHas = classes?.includes("has-") === true;
  const has = useHasOwner(usesHas);
  useHasRegistration(tag, attrs, stateKey);
  const hasEntries = usesHas ? has.entries : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: stateKey summarizes attrs
  const tw = useMemo(
    () =>
      styleFor(cn(TAG_CLASSES[tag], classes), theme.colors, theme.radius, {
        attrs,
        groups,
        dark: theme.mode === "dark",
        viewportWidth: theme.viewportWidth,
        has: hasEntries,
      }),
    // attrs is summarized by stateKey.
    [tag, classes, theme, stateKey, groups, hasEntries],
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
    clipRadius: inherited.clipRadius,
  };
  const textChanged =
    Object.keys(ownText).length > 0 ||
    tw.textTransform !== undefined ||
    tw.svg.size !== undefined ||
    tw.svg.color !== undefined;

  const items = flattenFragments(children).filter((item) => item !== "" && item !== null);
  const isInlineTag = INLINE_TAGS.has(tag);
  const display = tw.display ?? (isInlineTag ? "inline" : "block");
  const textOnly = items.length > 0 && items.every(isText);
  // A grid by class, or by an override (table rows set `display: "grid"`).
  const isGrid = display === "grid" || display === "inline-grid" || viewStyle?.display === "grid";
  const inlineFlow = !isGrid && !textOnly && items.length > 1 && items.every(isInlineNode);

  const view: ViewStyle = { ...tw.view, ...css.view };
  let direction: "row" | "column";
  if (display === "flex" || display === "inline-flex") direction = tw.direction ?? "row";
  else if (isGrid) direction = "column";
  else if (display === "inline" || display === "inline-block") direction = "row";
  // `space-x-*` only spaces a horizontal run, so a block using it is a row
  // (its children are often components, whose inline tags we cannot see).
  else if (tw.spaceX !== undefined && tw.spaceY === undefined) direction = "row";
  else direction = inlineFlow ? "row" : (tw.direction ?? "column");
  view.flexDirection = direction;
  if (isGrid) view.display = "grid";
  nextInherited.parentDirection = direction;
  nextInherited.parentGrid = isGrid;
  // `w-fit` sizes to content. Only a stretching column parent would widen it,
  // so only then pin it to the start; a centering parent keeps centering it.
  if (
    !inherited.parentGrid &&
    inherited.parentDirection === "column" &&
    inherited.parentStretches !== false &&
    view.width === "100%" &&
    (view.alignSelf ?? "stretch") === "stretch"
  ) {
    // A stretching column already fills the width; `width: 100%` adds
    // nothing but taffy's percentage pitfalls (an `aspect-square w-full`
    // button sized against the window while measuring its card).
    view.width = undefined;
  }
  if (
    !inherited.parentGrid &&
    inherited.parentDirection === "row" &&
    view.width === "100%" &&
    view.flexShrink !== 0 &&
    view.flexGrow !== 0 &&
    view.flex !== 0
  ) {
    // In a row, filling the parent is growth. A percentage of a row sized by
    // its content is cyclic: CSS ignores it while measuring, but taffy
    // resolves it against a far larger width (a calendar month in a `w-fit`
    // calendar measured as tall as the window).
    view.width = undefined;
    view.flexGrow ??= 1;
  }
  if (inherited.parentGrid) {
    // Grid items stretch across their cell by default, so `w-full`/`h-full`
    // add nothing there, and taffy resolves such percentages against the
    // whole grid while sizing tracks (an `aspect-square w-full` cell grew to
    // the grid's width).
    if (view.width === "100%" && (view.justifySelf ?? "stretch") === "stretch") {
      view.width = undefined;
    }
    if (view.height === "100%" && (view.alignSelf ?? "stretch") === "stretch") {
      view.height = undefined;
    }
  }
  // Inline-level boxes (`inline-flex` buttons and badges) keep their content
  // width in block flow instead of stretching across the column.
  if (
    (display === "inline-flex" || display === "inline-block" || display === "inline-grid") &&
    !inherited.parentGrid &&
    inherited.parentDirection === "column" &&
    inherited.parentStretches !== false
  ) {
    view.alignSelf ??= inherited.text.textAlign === "center" ? "center" : "flex-start";
  }
  if (tw.fitWidth && inherited.parentGrid) {
    // In a grid, width is the inline axis: stop the column from stretching it.
    view.justifySelf ??= "flex-start";
  } else if (
    tw.fitWidth &&
    inherited.parentDirection === "column" &&
    inherited.parentStretches !== false
  ) {
    view.alignSelf ??= "flex-start";
  }
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
  nextInherited.parentStretches = (view.alignItems ?? "stretch") === "stretch";
  if (view.overflow === "hidden" && typeof view.borderRadius === "number") {
    nextInherited.clipRadius = view.borderRadius;
  }

  const disabled = attrs.disabled === true || attrs["aria-disabled"] === "true";
  const interactive = !tw.pointerEventsNone && !disabled;
  // A button submits (or resets) its enclosing form, or the one named by `form="<id>"`.
  const formAction =
    tag === "button" && props.type !== "button" && (form !== null || typeof props.form === "string")
      ? props.type === "reset"
        ? "reset"
        : "submit"
      : undefined;
  const isSubmit = formAction !== undefined;
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
  } else {
    body = withSiblingPositions(renderChildren(items, tw, listStyle));
  }

  const element: ReactElement = (
    <View
      ref={tag === "form" ? undefined : (ref as never)}
      textStyle={nextInherited.text}
      testID={
        testID ??
        (typeof props["data-testid"] === "string" ? props["data-testid"] : undefined) ??
        (typeof props["data-slot"] === "string" ? props["data-slot"] : undefined)
      }
      occlude={occlude}
      dragRegion={dragRegion ?? (props["data-drag-region"] === true || undefined)}
      onLayout={onLayout}
      style={{ ...view, ...viewStyle }}
      onPress={
        pressable
          ? ({ bounds }) => {
              const event = syntheticEvent("click", { bounds });
              onMouseDown?.(event);
              onClick?.(event);
              if (!event.defaultPrevented && formAction) {
                const target = resolveForm(form, props.form);
                if (formAction === "reset") target?.reset();
                else target?.submit();
              }
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
    wrapped = (
      <FormScope
        id={typeof props.id === "string" ? props.id : undefined}
        onSubmit={onSubmit}
        onReset={props.onReset as typeof onSubmit}
        formRef={ref as Ref<FormHandle> | undefined}
      >
        {wrapped}
      </FormScope>
    );
  }
  if (tw.group !== undefined) {
    wrapped = (
      <GroupContext.Provider value={{ ...groups, [tw.group]: attrs }}>
        {wrapped}
      </GroupContext.Provider>
    );
  }
  if (
    textChanged ||
    direction !== inherited.parentDirection ||
    isGrid !== (inherited.parentGrid ?? false) ||
    nextInherited.clipRadius !== inherited.clipRadius ||
    nextInherited.parentStretches !== inherited.parentStretches
  ) {
    wrapped = (
      <InheritedContext.Provider value={nextInherited}>{wrapped}</InheritedContext.Provider>
    );
  }
  if (definedVars) {
    wrapped = <VarsContext.Provider value={scopeVars}>{wrapped}</VarsContext.Provider>;
  }
  if (has.scope) {
    wrapped = <HasContext.Provider value={has.scope}>{wrapped}</HasContext.Provider>;
  }
  return wrapped;
}
