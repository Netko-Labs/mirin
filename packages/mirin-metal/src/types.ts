/**
 * Public types for the Metal renderer: React components take React Native-
 * flavored props; the renderer translates them into the GPUI element tree
 * (crates/mirin-metal `tree.rs`) where GPUI's own flex engine lays them out.
 */

import type { ReactNode, Ref } from "react";

/** `#RGB`, `#RRGGBB`, or `#RRGGBBAA`. */
export type Color = string;

/** A length in pixels, or a percentage of the parent (`"50%"`). */
export type Dimension = number | `${number}%`;

/** Flexbox-flavored layout + appearance for a `<View>`. */
export interface ViewStyle {
  flexDirection?: "row" | "column";
  gap?: number;
  padding?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  /** Pixels, or `"auto"` to absorb free space (`marginLeft: "auto"` pushes right). */
  marginTop?: number | "auto";
  marginBottom?: number;
  marginLeft?: number | "auto";
  marginRight?: number | "auto";
  width?: Dimension;
  height?: Dimension;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /**
   * When the view's content height changes, its height follows over this
   * many ms (ease-out cubic, at most 1000) instead of jumping, its content
   * clipped meanwhile; appearing doesn't animate. Drawn in a clip, so it cuts
   * a shadow and ignores `flex`: put it on a content-sized view inside the
   * one with the shadow. Needs a host that names `MIRIN_METAL_RESIDENT`.
   */
  heightTransitionMs?: number;
  /** Width / height, e.g. `16 / 9`. */
  aspectRatio?: number;
  flexWrap?: "nowrap" | "wrap";
  /** `absolute` takes the view out of flow, anchored to the nearest `relative` ancestor. */
  position?: "relative" | "absolute";
  /**
   * Offsets. An absolute view is placed by them against its anchor; any
   * other is shifted by them from where the layout put it, its siblings
   * unmoved (React Native and CSS), as a view rising into place animates.
   */
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  /**
   * `flex: N` grows into the remaining space from a zero basis, as in React
   * Native and CSS `flex: N 1 0%` (Tailwind `flex-1`). Siblings split the space
   * by their `flex` values regardless of content.
   */
  flex?: number;
  /**
   * `flexGrow: N` grows from the content size instead (CSS `flex-grow`,
   * Tailwind `grow`/`flex-auto`): content is measured first, then extra space
   * is shared. Costlier than `flex`, so prefer `flex` when content size
   * shouldn't matter.
   */
  flexGrow?: number;
  /** `flexShrink: 0` keeps the view from shrinking below its content. */
  flexShrink?: 0 | 1;
  /**
   * `"baseline"` lines a row's items up by their first line of text, whatever its size: small
   * text beside larger text shares its baseline (centered, the two boxes line up and the small
   * text sits high). An item with no text is aligned by its bottom edge.
   */
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
  alignSelf?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  /**
   * `"grid"` lays children out as a CSS grid. `alignItems`/`alignSelf` then
   * align within each row (block axis), `justifyItems`/`justifySelf` within
   * each column (inline axis).
   */
  display?: "flex" | "grid";
  /** CSS `grid-template-columns`, one entry per track. */
  gridTemplateColumns?: GridTrack[];
  /** CSS `grid-template-rows`; rows are implicit (`auto`) otherwise. */
  gridTemplateRows?: GridTrack[];
  /** Where this view sits in its parent grid (CSS `grid-column`). */
  gridColumn?: GridPlacement;
  /** CSS `grid-row`. */
  gridRow?: GridPlacement;
  justifyItems?: "flex-start" | "center" | "flex-end" | "stretch";
  justifySelf?: "flex-start" | "center" | "flex-end" | "stretch";
  /** Gap between columns, overriding `gap` horizontally. */
  columnGap?: number;
  /** Gap between rows, overriding `gap` vertically. */
  rowGap?: number;
  backgroundColor?: Color;
  /** Background while the pointer is over the view. */
  hoverBackgroundColor?: Color;
  borderRadius?: number;
  borderWidth?: number;
  borderTopWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderRightWidth?: number;
  borderColor?: Color;
  /** Drop shadow preset. */
  shadow?: "xs" | "sm" | "md" | "lg" | "xl";
  /** `overflow: "hidden"` clips; `"scroll"` scrolls vertically, `"scroll-x"` horizontally, `"scroll-both"` both ways. */
  overflow?: "visible" | "hidden" | "scroll" | "scroll-x" | "scroll-both";
  opacity?: number;
  /**
   * The focus ring's color for this view and the `focusable` views inside it
   * (the nearest one set wins; a blue otherwise). The ring is 2 px wide, 2 px
   * out from the view, rounded to its `borderRadius` plus 4.
   */
  focusRingColor?: Color;
}

/** A text's weight: CSS's numbers and names. */
export type FontWeight =
  | "normal"
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900"
  | FontWeightName;

/** A weight by name, as the host takes it. */
export type FontWeightName =
  | "thin"
  | "extralight"
  | "light"
  | "medium"
  | "semibold"
  | "bold"
  | "extrabold"
  | "black";

/** Appearance for a `<Text>`. */
export interface TextStyle {
  color?: Color;
  fontSize?: number;
  /**
   * CSS's nine weights, by number or name. Lighter than `normal` and heavier
   * than `bold` need a host whose `protocol` event says `fontWeights` (an
   * older one refuses the tree); a family without the face draws the nearest.
   */
  fontWeight?: FontWeight;
  /**
   * `"monospace"` picks the system monospace family; `"display"` the display
   * cut of the sans family (Inter Display where installed, for numbers and
   * titles at 20 px and up; needs a host that says `displayFont`); anything
   * else is the default.
   */
  fontFamily?: "monospace" | "display" | "default";
  opacity?: number;
  textAlign?: "left" | "center" | "right";
  fontStyle?: "normal" | "italic";
  textDecorationLine?: "none" | "underline" | "line-through";
  lineHeight?: number;
  /** How far apart the text's tab stops are, in widths of its font's "0": 4 unless given (see `TextInputProps.tabSize`). */
  tabSize?: number;
}

/** Appearance for a `<TextInput>`. */
export interface TextInputStyle {
  color?: Color;
  placeholderColor?: Color;
  fontSize?: number;
  fontFamily?: "monospace" | "default";
  backgroundColor?: Color;
  padding?: number;
  /**
   * The room before and after the text, in place of `padding`'s at that
   * side: a field with a glyph drawn over its start (a search field's
   * magnifier) keeps its own edge and focus border, its text clear of it.
   */
  paddingLeft?: number;
  paddingRight?: number;
  borderRadius?: number;
  borderColor?: Color;
  /** Border while focused; falls back to `borderColor`. */
  focusBorderColor?: Color;
  /** Pixels, or `"100%"` to fill the parent's width (CSS `width: 100%`). */
  width?: number | "100%";
  height?: number;
  minHeight?: number;
  flex?: number;
  /**
   * A one-line field's text at its right edge (a calculator's line), with
   * room for the caret after it. Either way, a line longer than the field
   * scrolls to keep the caret in view.
   */
  textAlign?: "left" | "right";
}

/**
 * One grid track: pixels, a share of the free space (`"1fr"`), a percentage of
 * the grid (`"25%"`), a content keyword, or `minmax(min, max)`.
 */
export type GridTrack =
  | number
  | `${number}fr`
  | `${number}%`
  | "auto"
  | "min-content"
  | "max-content"
  | { min: Exclude<GridTrack, `${number}fr` | object>; max: Exclude<GridTrack, object> };

/** 1-based grid lines (negative counts from the end) and spans. */
export interface GridPlacement {
  start?: number;
  end?: number;
  span?: number;
}

/** A pointer phase on a view with `onPointer`, in window pixels. */
export interface PointerInfo {
  phase: "down" | "move" | "up";
  x: number;
  y: number;
  /** The view's painted bounds when the event fired. */
  bounds?: Bounds;
  /**
   * The modifier keys held at this phase (a ⇧-drag adds, a ❖-drag toggles).
   * One pressed or let go while the button is down comes as a `move` where
   * the pointer is. Absent from a host that does not say them (older than
   * 2026-11-14): fall back to what a click says.
   */
  modifiers?: Modifiers;
}

/** The modifier keys held during a press, a right-click or a pointer phase (`super` is the Super, ❖, key). */
export interface Modifiers {
  shift: boolean;
  control: boolean;
  alt: boolean;
  super: boolean;
}

/** A press on a view with `onPress`: its painted bounds and the modifiers held (none for Space or Enter on a focused view). */
export interface PressInfo {
  bounds?: Bounds;
  modifiers: Modifiers;
}

/** A key on a view with `onKeyDown`: GPUI's key name ("a", "enter", "left", "f5"), the text it types, and the modifiers (`meta` is Super). */
export interface KeyDownInfo {
  key: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  repeat: boolean;
}

/** A key no focused control took, on a view with `onWindowKeyDown`; Ctrl+V carries the clipboard's text in `pasted`. */
export interface WindowKeyInfo extends KeyDownInfo {
  pasted?: string;
}

/** Files a view drags out (`dragFiles`): pressing it and moving a few pixels starts the drag. */
export interface DragFiles {
  /** Absolute paths. */
  paths: string[];
  /** A PNG, JPEG, or SVG file shown under the pointer while dragging. */
  icon?: string;
  /** The icon's size in pixels (default 48). */
  iconSize?: number;
}

/**
 * Files dragged over a view with `onDrop`, or dropped on it, in window
 * pixels: `enter` and `over` while they move over it (the deepest such view
 * under the pointer gets them), `leave` when they go elsewhere or the drag
 * ends, `drop` when the button goes up there (no `leave` follows). The
 * keyboard's modifiers are as they were at that moment. `paths` is empty
 * on `leave`.
 */
export interface DropInfo {
  phase: "enter" | "over" | "leave" | "drop";
  x: number;
  y: number;
  paths: string[];
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** The wheel or touchpad over a view with `onWheel`, in lines (positive `dy` is toward the content's start). */
export interface WheelInfo {
  dx: number;
  dy: number;
}

/**
 * Where a scroll view stands, as React Native's scroll event says it (without
 * the `nativeEvent` around it): how far it is scrolled from its content's
 * start, how large the content is, and how large the view is, in px.
 */
export interface ScrollInfo {
  /** Never negative, and whole or not as the view is scrolled (a touchpad scrolls by parts of a pixel). */
  contentOffset: { x: number; y: number };
  contentSize: { width: number; height: number };
  layoutMeasurement: { width: number; height: number };
}

/**
 * What a `<View>`'s (or `<ScrollView>`'s) `ref` holds, besides being a
 * `createPortal` target: `const list = useRef<ViewHandle>(null)`. The methods
 * need a host whose `protocol` event says `scroll`; on an older one they do
 * nothing.
 */
export interface ViewHandle {
  /**
   * Scroll this scroll view to an offset from its content's start, in px
   * (React Native's `scrollTo`, without `animated`: it jumps). An axis left
   * out stays where it is, and the view keeps the offset in its range, so
   * `onScroll` says where it ended.
   */
  scrollTo(offset: { x?: number; y?: number }): void;
  /** Scroll this scroll view to its end: the bottom, or the right edge of one that only scrolls across. */
  scrollToEnd(): void;
  /**
   * Scroll every scroll view around this view the least that shows it whole
   * (the DOM's `scrollIntoView({ block: "nearest", inline: "nearest" })`):
   * nothing when it already shows, to its start when it is longer than the
   * view. A view that came with this commit is shown once it is drawn, and a
   * row a long list has not laid out yet is brought in too.
   */
  scrollIntoView(): void;
}

/** Painted bounds of a node in window pixels. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The window's title bar style: the compositor's (`standard`) or the app's own toolbar (`unified`). */
export type TitleBarStyle = "standard" | "unified";

/** What `useWindowChrome()` returns. */
export interface WindowChrome {
  /** The style the window effectively has: `unified` only where the compositor honored it. */
  titleBar: TitleBarStyle;
  /**
   * The area the compositor's window controls cover over the window, in window
   * pixels from its top-left; keep it empty. `null` when there are none.
   */
  controls: Bounds | null;
}

/**
 * What assistive technology hears of a view or a field (React Native's
 * accessibility props). The host publishes an accessibility tree over
 * AT-SPI on Linux (`crates/mirin-metal/src/access/`), so a screen reader
 * such as Orca reads it. Without them a pressable view is a button named by
 * its text, a text is read as it is, and a field is named by its placeholder.
 * Only a host binary that names `MIRIN_METAL_ACCESSIBLE` takes them: an
 * older one rejects a tree that has them, so a driver checks for it first.
 */
export interface AccessibilityProps {
  /** What it is. A `combobox` field over a `listbox` of `option`s reads as a search with results. */
  accessibilityRole?: AccessibilityRole;
  /** What it is called; on a view it stands for the text inside it. */
  accessibilityLabel?: string;
  /** Selected (the option a combo box's selection is on), checked, expanded, disabled. */
  accessibilityState?: {
    selected?: boolean;
    checked?: boolean;
    expanded?: boolean;
    disabled?: boolean;
  };
  /** A change to it is announced as it happens (`polite` waits for a pause). */
  accessibilityLiveRegion?: "polite" | "assertive" | "none";
}

export type AccessibilityRole =
  | "button"
  | "link"
  | "combobox"
  | "listbox"
  | "option"
  | "list"
  | "listitem"
  | "group"
  | "status"
  | "alert"
  | "heading"
  | "header"
  | "switch"
  | "checkbox"
  | "image"
  | "text"
  | "menu"
  | "menuitem"
  | "tab"
  | "tablist"
  | "dialog"
  | "search";

export interface ViewProps extends AccessibilityProps {
  /**
   * Receives the mounted host instance: a `createPortal` target and a
   * `ViewHandle` (`scrollTo`, `scrollToEnd`, `scrollIntoView`).
   */
  ref?: Ref<unknown>;
  style?: ViewStyle;
  /**
   * Style for strings placed directly in this view (for example, a string a
   * child component returns). Without it they render with default styling.
   */
  textStyle?: TextStyle;
  /**
   * Click/tap. `bounds` is the view's painted rect, for anchoring popups;
   * `modifiers` are the keys held (⇧-click extends, ❖-click toggles). Only
   * the innermost `onPress` view under the pointer fires; views around it
   * (or drawn under it) with their own `onPress` don't. Space or Enter on a
   * `focusable` view presses it too, with no modifiers.
   */
  onPress?: (event: PressInfo) => void;
  /**
   * Takes the keyboard: Tab and ⇧Tab reach it (with text fields, in
   * document order), Space and Enter press it, and it shows a focus ring
   * once the keyboard moved focus there (`:focus-visible`). A press with
   * the pointer doesn't focus it. Needs a host that names `MIRIN_METAL_FOCUS`.
   */
  focusable?: boolean;
  /**
   * The `focusable` views inside are one Tab stop, and the arrow keys move
   * between them (a segmented control, a radio group, a list). Tab enters
   * at the one that last had the keyboard, else the one whose
   * `accessibilityState` is selected or checked, else the first.
   */
  focusGroup?: boolean;
  /** In a `focusGroup`: the arrows press the view they reach, so the selection follows the keyboard (a sidebar, a tab list). */
  selectsOnFocus?: boolean;
  /** While it is shown, Tab and ⇧Tab stay inside it (a sheet, a dialog); the last one in the tree holds them. */
  focusTrap?: boolean;
  /**
   * Draw the focus ring on this view now, as if the keyboard had moved
   * there: for a surface that keeps its own keyboard (a grid the arrows walk
   * in two directions) and says where it is. The ring is the focus ring's
   * own (`focusRingColor`, 2 px wide, 2 px out, round with the view), shown
   * only while the window is active, so no surface draws a ring by hand.
   * Needs a host that names `MIRIN_METAL_FOCUS_SHOWN`.
   */
  focusRingShown?: boolean;
  /**
   * The keys no focused control takes: while no field or `onKeyDown` view
   * has the keyboard (the window has it, or a `focusable` view that doesn't
   * use the key: not Tab, Space, Enter, or an arrow in a group). Never takes
   * the keyboard itself; the last such view in the tree hears them, and one
   * appearing gives the keyboard back to the window. A window with nothing
   * to type into gets its shortcuts this way.
   */
  onWindowKeyDown?: (event: WindowKeyInfo) => void;
  /** Pointer entered (`true`) or left (`false`) the view. */
  onHoverChange?: (hovered: boolean, bounds?: Bounds) => void;
  /**
   * Stop pointer events from reaching views painted underneath (overlays),
   * the wheel included: a wheel over an open menu or a sheet never scrolls
   * the page beneath. Views inside it are drawn over it and still get them.
   */
  occlude?: boolean;
  /**
   * Behaves like a title bar: pressing here moves the window, double-clicking
   * zooms it. Descendants with their own `onPress`, `onPointer`, or a
   * `TextInput` keep the clicks on them. Use it on a unified toolbar's empty
   * areas (see `useWindowChrome`).
   */
  dragRegion?: boolean;
  /** Called with the view's painted bounds whenever they change. */
  onLayout?: (bounds: Bounds) => void;
  /**
   * Press on this view, then every move and the release until the button
   * lifts, each with the `modifiers` held. The innermost `onPointer` view
   * under the pointer captures it.
   */
  onPointer?: (event: PointerInfo) => void;
  /** Right-click, in window pixels, with the modifiers held. Only the innermost `onContextMenu` view fires. */
  onContextMenu?: (event: { x: number; y: number; modifiers: Modifiers }) => void;
  /**
   * Take the keyboard (when the view appears and when pressed) and receive
   * every key raw, with its modifiers. For views that handle keys
   * themselves, like a terminal; text fields don't need it.
   */
  onKeyDown?: (event: KeyDownInfo) => void;
  /** The wheel or touchpad scrolled over this view, in lines. */
  onWheel?: (event: WheelInfo) => void;
  /**
   * A scroll view's offset changed, whoever moved it: the wheel, its scroll
   * bar, `scrollTo`, `scrollIntoView`, or its content getting shorter. At
   * most once a frame; a view that was never scrolled is at 0, 0 and says
   * nothing. On a view that scrolls (`<ScrollView>`, `overflow: "scroll"`),
   * a long list included; needs a host whose `protocol` event says `scroll`
   * (an older one is not told of the handler, and never calls it).
   */
  onScroll?: (event: ScrollInfo) => void;
  /**
   * At most one `onScroll` every this many ms (React Native's name). The
   * offset the view ends on is always told, once the wait is over. 0 or
   * absent: every frame it moved.
   */
  scrollEventThrottle?: number;
  /**
   * Drag these files out of the window: a press here and a move of a few
   * pixels starts it, and any app's window that takes files gets them (this
   * one's `onDrop` views included). A click without moving is still a press.
   */
  dragFiles?: DragFiles;
  /** Files dragged over this view or dropped on it. */
  onDrop?: (event: DropInfo) => void;
  /**
   * The view's opacity in a loop (a tag that breathes), drawn by the host a
   * few steps a second, never every frame; it stands still at `to` under
   * Reduce Motion (`NativeHostTransport.setReduceMotion`). Multiplies the
   * style's `opacity`. Needs a host whose `protocol` event says `pulse` (an
   * older one refuses the tree).
   */
  pulse?: Pulse;
  /** Stable handle for checks and tools (`root.nodeId(testID)`); never rendered. */
  testID?: string;
  children?: ReactNode;
}

/** A view's breathing (`ViewProps.pulse`). */
export interface Pulse {
  /** The faintest it gets, 0–1 (0.4 unless given). */
  from?: number;
  /** The fullest, and where it stands under Reduce Motion, 0–1 (1 unless given). */
  to?: number;
  /** One breath, down and up, in ms (2000 unless given; 400 at least). */
  periodMs?: number;
  /** Steps a second, 1–10 (4 unless given). */
  fps?: number;
}

/**
 * A row or field of dots drawn by the host in one paint, with no view per
 * dot: progress, a history, a picture in dots. `count` across, `rows` down,
 * centres `pitch` apart, each `radius` round; the first `lit` in `color`,
 * the rest in `unlitColor` (not drawn without it); `head` one dot in
 * `headColor` (a ring with `headRing`). `cells` says each dot instead,
 * row by row: `0` unlit, `1` lit, `2` a ring. At most 4096 dots are drawn.
 * Needs a host whose `protocol` event says `dots` (an older one refuses
 * the tree).
 */
export interface DotsProps {
  count: number;
  rows?: number;
  pitch: number;
  radius: number;
  lit?: number;
  color?: Color;
  unlitColor?: Color;
  head?: number;
  headColor?: Color;
  headRing?: boolean;
  cells?: string;
  opacity?: number;
}

export interface TextProps {
  style?: TextStyle;
  /** Keep on one line and cut with an ellipsis instead of wrapping. */
  numberOfLines?: 1;
  children?: ReactNode;
}

export interface TextInputProps extends AccessibilityProps {
  /**
   * Controlled value. Setting the text the field last reported leaves the
   * native buffer alone; any other value replaces it. Keys typed before
   * the field took such a value (the app wrote as the person typed) are not
   * lost: the field types them again into the value and reports the result
   * through `onChangeText`, which never hears a text typed on a value the
   * app has since replaced (a host from before 2026-11-15 resets instead,
   * and reports what was typed on the old text).
   */
  value: string;
  /**
   * Bump it to write `value` to the field again even when `value` didn't change: after
   * refusing an edit (a key the app took for itself), so the field shows `value` again.
   * It is a write as a new `value` is: what was typed after the text the app refused is
   * typed again on `value` and reported through `onChangeText`, so taking a key out
   * costs no key after it ("12x+3" typed at once, the "x" refused: "12+3"). A host
   * whose `protocol` event does not say `revisionRebase` resets the field to `value`
   * and drops those keys.
   */
  valueRevision?: number;
  placeholder?: string;
  multiline?: boolean;
  /** Mask the text (passwords). */
  secureTextEntry?: boolean;
  autoFocus?: boolean;
  style?: TextInputStyle;
  onChangeText?: (text: string) => void;
  /** Enter (single line) or Ctrl/Cmd+Enter (multiline). */
  onSubmitEditing?: (text: string) => void;
  /**
   * Enter also moves the keyboard to the next field or control, as Tab does, in the host:
   * keys typed right after land there, not here (a note's title, then its body).
   */
  focusNextOnSubmit?: boolean;
  /**
   * What Enter does in a multiline field, as React Native's: "newline" (the default) breaks
   * the line; "submit" submits instead, for a field that wraps but holds one paragraph (a
   * note's title). Ctrl/Cmd+Enter always submits. A single-line field always submits.
   */
  submitBehavior?: "submit" | "newline";
  /**
   * What Tab does in a multiline field: "focus" (the default) moves the keyboard to the next
   * control; "insert" types a tab, for a document's text (a text editor). Shift+Tab still moves
   * the keyboard back (unless `onShiftTab` is given), and Ctrl/Cmd+Tab on. A single-line field
   * always moves it.
   */
  tabBehavior?: "focus" | "insert";
  /**
   * In a multiline field with `tabBehavior="insert"`: Shift+Tab is the app's (a list item
   * outdented) and the keyboard stays; Ctrl/Cmd+Shift+Tab still moves it back. Needs a host
   * whose `protocol` event says `shiftTabKey` (an older one refuses the tree).
   */
  onShiftTab?: () => void;
  /**
   * How far apart the field's tab stops are, counted in the width of its font's "0" (CSS's
   * `tab-size` in `ch`): 4 unless given, from 1 to 64. A tab moves what follows it to the next
   * stop, so columns line up; the caret, the selection and a click follow. In a fixed-pitch font
   * that is as many spaces.
   */
  tabSize?: number;
  /**
   * Navigation keys the input doesn't use itself (a launcher's list): Escape, and
   * ArrowUp / ArrowDown in a single-line field (a multiline one moves its caret).
   */
  onKeyPress?: (key: "Escape" | "ArrowUp" | "ArrowDown") => void;
  /**
   * Controlled caret and selection, as React Native's: offsets into `value` (JavaScript
   * string indices). When it changes, or the native buffer is reset, the field selects
   * it; `start` is where the selection begins and `end` where the caret is. One set
   * while keys the app has not heard of yet were typed is not taken: its offsets are
   * into the text the app knew, and the caret stays with what was typed (which
   * `onChangeText` and `onSelectionChange` then report). So a caret at the end of a
   * `value` the app writes can always be sent.
   */
  selection?: TextSelection;
  /**
   * The person or the field moved the caret or changed the selection: a key, a click or
   * a drag, typing, the caret the field kept when it typed its keys again on a `value`
   * the app wrote meanwhile, the caret at the end of a `value` set with no `selection`.
   * Not called for a `selection` the app set and the field took as set (React Native on
   * iOS does the same; on Android it calls it), so mirroring what it hears into
   * `selection` is safe: the app's own caret never comes back as a move. A `selection`
   * the field could not take as set (past the end of the text) is reported as where it
   * went. A host whose `protocol` event does not say `noSelectionEcho` also reports
   * the app's own `selection` back.
   */
  onSelectionChange?: (selection: TextSelection) => void;
  /** Drawn behind selected text; defaults to the nearest `TextInputDefaults`, else a translucent blue. */
  selectionColor?: Color;
  /**
   * How parts of the text are drawn (a Markdown note formatted as it is typed):
   * the value stays plain text, and the caret, selection and edits work as in
   * plain text. Later runs win where they overlap. A host without
   * `MIRIN_METAL_RUNS` refuses a tree with runs.
   */
  runs?: readonly TextRun[];
  /** A press on a run with `press` (the caret stays where it was): which run, by its index in `runs`. */
  onRunPress?: (event: RunPressInfo) => void;
  /**
   * Ranges washed behind the text, each in its own color, whether or not the field has the
   * keyboard, under the selection (find's matches). Offsets into `value`, as `selection`'s.
   */
  highlights?: readonly TextHighlight[];
  /**
   * A multiline field's line numbers, in a gutter `width` px wide at the text's left (added
   * to its padding), each in `color` at its line's first drawn row, 10 px before the text.
   */
  lineNumbers?: LineNumbers;
  /** Stable handle for checks and tools (`root.nodeId(testID)`); never rendered. */
  testID?: string;
}

/** A key a field gives its app (`TextInput`'s `onKeyPress`, and `onShiftTab` for "Shift+Tab"). */
export type TextInputKey = "Escape" | "ArrowUp" | "ArrowDown" | "Shift+Tab";

/** A range of a field's text washed in `color` (`TextInput`'s `highlights`). */
export interface TextHighlight {
  start: number;
  end: number;
  color: Color;
}

/** A multiline field's line-number gutter (`TextInput`'s `lineNumbers`). */
export interface LineNumbers {
  width: number;
  color: Color;
}

/**
 * A styled run over a field's text: offsets into `value` (JavaScript string
 * indices), `start <= end`, and how that text is drawn.
 */
export interface TextRun {
  start: number;
  end: number;
  color?: Color;
  /** A wash behind the text (code, a search match). */
  backgroundColor?: Color;
  /** Past `normal`–`bold` needs a host that says `fontWeights`. */
  fontWeight?: "normal" | FontWeightName;
  fontStyle?: "normal" | "italic";
  textDecorationLine?: "none" | "underline" | "line-through";
  /** Draws every paragraph the run is in at this size (a heading); a line has one size. */
  fontSize?: number;
  /** A press on the run is reported (`onRunPress`) instead of placing the caret: a checkbox in the text. */
  press?: boolean;
  /** Draws the run in the monospace family (code) or, in a monospace field, the body font. */
  fontFamily?: "monospace" | "default";
}

/** A press on a field's pressable run. */
export interface RunPressInfo {
  /** The run's index in `runs`. */
  run: number;
  /** The offset nearest the pointer, where a click would have put the caret. */
  offset: number;
  modifiers: Modifiers;
}

/**
 * A field's caret and selection: offsets into its text (JavaScript string indices).
 * Equal, it is the caret alone; reported with `start <= end`.
 */
export interface TextSelection {
  start: number;
  end: number;
}

/** What every `<TextInput>` below a `TextInputDefaults` provider takes unless it says otherwise. */
export interface TextInputDefaultProps {
  selectionColor?: Color;
}

export interface SvgProps {
  /** A complete `<svg>` document; strokes and fills are tinted with `color`. */
  markup: string;
  size?: number;
  width?: number;
  height?: number;
  color?: Color;
  opacity?: number;
}

/** Why an image could not be drawn (React Native's image error, without the `nativeEvent` around it). */
export interface ImageErrorInfo {
  /** "no such file", "not a file", "the file cannot be read", or "not an image the host can decode". */
  error: string;
}

export interface ImageProps {
  /**
   * Absolute path to a local image file: PNG, JPEG, GIF, WebP, BMP, ICO, or
   * an SVG document (drawn at its own size and scaled as a picture, so one
   * shown larger than it says is soft; `<Svg>` draws markup sharp). Any other
   * format (AVIF, HEIC, TIFF) is drawn as nothing: see `onError`.
   */
  source: string;
  /**
   * The file could not be drawn: it is not there, or not an image the host
   * decodes, whatever its name says. Called once for each `source` that
   * fails, after the host has tried to load it; the image is drawn as
   * nothing, so the app shows what it has instead (another file, a glyph).
   * Needs a host whose `protocol` event says `imageError`; an older one is
   * not told of the handler, and never calls it.
   */
  onError?: (event: ImageErrorInfo) => void;
  resizeMode?: "cover" | "contain";
  style?: {
    width?: number;
    height?: number;
    borderRadius?: number;
    opacity?: number;
    flex?: number;
  };
}

/** Painted bounds of one node, in window pixels (from a `layout` query). */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An interaction event coming back from the native UI. */
export type NativeEvent =
  /** `modifiers` is absent from a host older than `MIRIN_METAL_FOCUS`. */
  | { type: "press"; nodeId: string; bounds?: Bounds; modifiers?: Modifiers }
  /**
   * A field's text after an edit. `baseHash` names the text the edit was
   * made on and `textHash` the value itself (`textHash()` of each; a host
   * from before 2026-11-15 says neither). `render` passes `onChangeText`
   * only a change made on what the app last set or heard; one typed on a
   * text the app has since replaced is dropped, and the host, once it takes
   * the app's value, reports the typing carried onto it. A listener on the
   * transport hears every one.
   */
  | { type: "change"; nodeId: string; value: string; baseHash?: number; textHash?: number }
  | { type: "submit"; nodeId: string; value: string }
  | { type: "key"; nodeId: string; value: TextInputKey }
  /** `textHash` names the text the offsets are into (lib/text-hash.ts); an older host leaves it out. */
  | ({ type: "selection"; nodeId: string; textHash?: number } & TextSelection)
  | { type: "runpress"; nodeId: string; run: number; offset: number; modifiers: Modifiers }
  | { type: "hover"; nodeId: string; hovered: boolean; bounds?: Bounds }
  | ({ type: "pointer"; nodeId: string } & PointerInfo)
  | { type: "contextmenu"; nodeId: string; x: number; y: number; modifiers?: Modifiers }
  | ({ type: "keydown"; nodeId: string } & KeyDownInfo)
  | ({ type: "windowkey"; nodeId: string } & WindowKeyInfo)
  /**
   * The compositor says the window is out of sight (`visible: false`:
   * minimized, on another desktop) or seen again; only changes are sent,
   * and a window opens seen. Where the compositor can't tell, never sent.
   */
  | { type: "visibility"; nodeId: "root"; visible: boolean }
  /**
   * A text field took the keyboard (`typing: true`), or none has it any
   * more; only changes are sent, and a window opens not typing. A view with
   * `onKeyDown` is not typing. A host older than this never sends it.
   */
  | { type: "typing"; nodeId: "root"; typing: boolean }
  /**
   * The host applies tree patches of protocol `patches` (sent once, as it
   * starts): `render` then sends only what each commit changed. A host older
   * than patches never sends it, and gets the whole tree every commit.
   * `settle` is true from a host that takes the `settle` simulation, and
   * `activation` from one that takes the `activate` and `deactivate`
   * window simulations,
   * `rebase` from one that takes a field's `baseHash` (the text its `value`
   * was set over) and carries what was typed meanwhile onto the value,
   * `selectionHash` from one that takes a `selection` with the hash of the
   * text it was made in, and drops one made in a text the field no longer
   * holds,
   * `noSelectionEcho` from one that does not report back a `selection` the
   * driver set (`onSelectionChange`),
   * `revisionRebase` from one that carries what was typed onto the value
   * of a new `valueRevision` too (older ones reset the field to it),
   * `scroll` from one that reports a scroll view's offset (`onScroll`) and
   * takes `scrollTo` and `scrollIntoView` (`ViewHandle`), `imageError` from
   * one that says when an image cannot be drawn (`onError`),
   * `opaqueSurface` from one that opens a surface that says `opaque` so,
   * `runFont` from one that draws a `TextRun`'s `fontFamily` (an older host
   * refuses a tree with it), `shiftTabKey` from one that takes a field's
   * `onShiftTab` (an older host refuses that field), and `fieldText` from
   * one whose fields publish their text to screen readers and agents and
   * that takes the `settext` and `inserttext` simulations. `fontWeights`
   * from one that draws all nine weights (thin to black), `displayFont` from
   * one that takes `fontFamily: "display"`, `dots` from one that draws
   * `<Dots>`, and `pulse` from one that takes a view's `pulse` and
   * `setReduceMotion`: an older host refuses a tree with any of them.
   */
  | {
      type: "protocol";
      nodeId: "root";
      patches: number;
      settle?: boolean;
      activation?: boolean;
      rebase?: boolean;
      selectionHash?: boolean;
      noSelectionEcho?: boolean;
      revisionRebase?: boolean;
      scroll?: boolean;
      imageError?: boolean;
      opaqueSurface?: boolean;
      fieldText?: boolean;
      runFont?: boolean;
      shiftTabKey?: boolean;
      fontWeights?: boolean;
      displayFont?: boolean;
      dots?: boolean;
      pulse?: boolean;
    }
  /**
   * The answer to a `settle` simulation: the window has settled (`quiet`),
   * or still waited for a frame when the host gave up (20 s, or a minute of
   * animation under `MIRIN_METAL_CHECK=1`). From a host that traces scenes
   * (`MIRIN_METAL_TRACE_SCENE`), `scene` is the digest of the last frame
   * drawn, and under `MIRIN_METAL_CHECK=1` `frames` is a digest of every
   * frame drawn to settle, in order (`"0"` when none was).
   */
  | { type: "settled"; nodeId: "root"; quiet: boolean; scene?: string; frames?: string }
  /** A patch didn't apply (`reason`): the host wants the whole tree, and drops patches until it comes. */
  | { type: "resync"; nodeId: "root"; reason: string }
  | ({ type: "wheel"; nodeId: string } & WheelInfo)
  /** A scroll view with `onScroll` stands somewhere else: its offset, its content's size and its own. */
  | {
      type: "scroll";
      nodeId: string;
      x: number;
      y: number;
      contentWidth: number;
      contentHeight: number;
      width: number;
      height: number;
    }
  /** An image with `onError` could not be drawn: why. */
  | { type: "imageerror"; nodeId: string; error: string }
  | ({ type: "drop"; nodeId: string } & DropInfo)
  | { type: "resize"; nodeId: string; bounds: Bounds }
  | { type: "layout"; nodeId: "root"; nodes: LayoutNode[] }
  | ({ type: "chrome"; nodeId: "root" } & WindowChrome)
  /** A newly opened window painted its first frame (once per open). */
  | { type: "frame"; nodeId: "root" }
  /**
   * Something outside asked the window to close (the close control, a
   * shell's close or quit) and it stayed: the host was spawned with
   * `askToClose`. Answer with `close()` on the transport, or ask first.
   */
  | { type: "close-request"; nodeId: "root" };

/**
 * Simulated input for checks: delivered inside the renderer like real input
 * (keys go through GPUI's keystroke dispatch; clicks resolve against the
 * painted layout and reach the node's handler).
 */
export type SimCommand =
  | { kind: "click"; id: string }
  | { kind: "click"; x: number; y: number }
  | { kind: "key"; keystroke: string }
  | { kind: "type"; text: string }
  | { kind: "layout" }
  | { kind: "drag"; id: string; fromX?: number; fromY?: number; toX?: number; toY?: number }
  | { kind: "contextmenu"; id: string }
  | { kind: "hover"; id: string; hovered: boolean }
  /** Move the pointer to node `id`'s centre (or `x`, `y`) as a real pointer would: hover styles respond. */
  | { kind: "move"; id: string }
  | { kind: "move"; x: number; y: number }
  /**
   * Scroll a scrollable node down by `dy` px (negative scrolls up) and right
   * by `dx` (negative scrolls left; a virtualized list scrolls down only).
   */
  | { kind: "scroll"; id: string; dy: number; dx?: number }
  /** Give the keyboard to a field or `focusable` view, pressing nothing (a screen reader's focus). */
  | { kind: "focus"; id: string }
  /**
   * Put `text` in field `id` in place of all it holds (`settext`) or of its
   * selection (`inserttext`), as typing it would: `onChangeText` fires and
   * the keyboard stays where it is (an agent's or a screen reader's
   * `SetTextContents` and `InsertText`). Only a host whose `protocol` event
   * says `fieldText: true` takes them.
   */
  | { kind: "settext"; id: string; text: string }
  | { kind: "inserttext"; id: string; text: string }
  /**
   * Ask for a `settled` event once the window has settled: everything sent
   * before this (trees, patches, sizes, simulations) is applied, a frame
   * with it is drawn, and the window waits for no other (no view is dirty,
   * no animation asked for a frame). Lines sent after it wait for its
   * answer, and what the app does in answer to the events before
   * `settled` is applied after it, so a check that presses
   * something sends `settle` again once its driver has answered, until a
   * round brings nothing new (`bench/layout-check.tsx` in
   * `@mirinjs/metal-ui`). Only a host whose `protocol` event says
   * `settle: true` takes it; one from before refuses the line. With
   * `MIRIN_METAL_CHECK=1` in the host's environment the window hears no
   * input but simulated input, animations run to their end at once, and
   * from its first `settle` on the window draws only to settle, without
   * waiting for the compositor.
   */
  | { kind: "settle" }
  | { kind: "window"; action: "zoom" | "minimize" }
  /**
   * Make the window count as not the active one (`deactivate`: as when
   * another window takes the keyboard) or as active again (`activate`), so
   * a check can see how an inactive window draws: a focus ring shows only
   * in an active window, and a screen reader hears the window's state.
   * Under `MIRIN_METAL_CHECK=1` a window is active whatever the compositor
   * says, from its start and until a `deactivate`, and what is simulated
   * holds until the next simulation; without it the compositor's next word
   * replaces it. A simulation that changes nothing draws nothing. Only a
   * host whose `protocol` event says `activation: true` takes them; one
   * from before logs "unknown action" and stays as it was.
   */
  | { kind: "window"; action: "activate" | "deactivate" };

/**
 * The channel to the native renderer. `spawnNativeHost` provides the stdio
 * implementation; the eventual FFI wiring will provide an in-process one.
 */
/**
 * The stdio host's transport. Toplevel members need the `shell.toplevels`
 * capability (`spawnNativeHost(binary, { capabilities: ["shell.toplevels"] })`).
 */
export interface NativeHostTransport extends NativeTransport {
  /** Windows appearing, changing, and closing; replays nothing on attach. */
  onToplevel(listener: (event: ToplevelEvent) => void): void;
  /** Activate, minimize, maximize, or close another window. */
  toplevel(id: number, action: ToplevelAction): void;
  /**
   * Unlock the session a `{ role: "lock" }` surface locked, then the host
   * exits. The only way it unlocks: closing or killing the host leaves the
   * session locked.
   */
  unlock(): void;
  /**
   * Retitle the window: what the compositor's title bar, the window
   * switcher, and the taskbar show. The title given at spawn is the first.
   */
  setTitle(title: string): void;
  /**
   * Resize the window, in px: an app growing to show a sidebar, and
   * shrinking when it goes. The compositor has the last word (a zoomed or
   * tiled window keeps its size, and a zoomed one's size to go back to moves by
   * as much as asked; the window reports its size as ever,
   * through the root's layout). A host from before it refuses the line (on stderr).
   */
  setSize(width: number, height: number): void;
  /**
   * Change the smallest the person can make the window, in px (the spawn's
   * `minWidth`/`minHeight` is the first): an app whose layout needs more
   * room while it shows more (a sidebar beside a fixed column). It doesn't
   * resize the window; ask with `setSize` too. A host from before it refuses
   * the line (on stderr) and keeps the first.
   */
  setMinSize(width: number, height: number): void;
  /**
   * Open the window of a host spawned with `deferred: true`: once, or again
   * after `hide()` on a host that names `MIRIN_METAL_RESIDENT` (an open while
   * the window is shown is refused by the host).
   */
  open(options: NativeWindowOptions): void;
  /**
   * Close a deferred host's window but keep the host: its GPU context, fonts,
   * and the newest tree sent (trees sent meanwhile are kept, newest wins), so
   * the next `open()` draws at once (a resident host; needs a host that names
   * `MIRIN_METAL_RESIDENT`). Not a close: `onClose` doesn't fire.
   */
  hide(): void;
  /**
   * Turn Reduce Motion on or off for the host: pulsing views (`pulse`)
   * stand still while it is on. Kept across `hide()` and `open()`. A host
   * whose `protocol` event does not say `pulse` refuses the line (on stderr).
   */
  setReduceMotion(reduce: boolean): void;
}

/** What a window is: what `open()` takes for a host spawned deferred. */
export interface NativeWindowOptions {
  title?: string;
  appId?: string;
  width?: number;
  height?: number;
  /**
   * The smallest the person can make the window, in px, as
   * `NativeHostOptions.minWidth`/`minHeight`: both or neither. A host from
   * before it refuses the whole open line (its fields are checked), so a
   * driver sends them only to a host that names `MIRIN_METAL_OPEN_MIN_SIZE`.
   */
  minWidth?: number;
  minHeight?: number;
  surface?: unknown;
  titleBar?: "standard" | "unified";
}

export interface NativeTransport {
  send(treeJson: string): void;
  onEvent(listener: (event: NativeEvent) => void): void;
  /** The native side went away (window closed, host exited). */
  onClose(listener: () => void): void;
  /** Inject simulated input or ask for a layout snapshot. */
  simulate(command: SimCommand): void;
  close(): void;
}

/** A mounted native React root. */
export interface NativeRoot {
  unmount(): void;
  /** The JSON tree most recently sent to the renderer, or null before the first commit. */
  lastTree(): string | null;
  /** The native node id behind a `testID`, if that node is mounted. */
  nodeId(testID: string): string | undefined;
}

// shell.toplevels: other windows, as the compositor reports them.

/** A window as the compositor describes it; `id` may be reused once it closes. */
export interface Toplevel {
  id: number;
  title: string;
  appId: string;
  activated: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

export type ToplevelEvent =
  | { type: "changed"; toplevel: Toplevel }
  | { type: "closed"; id: number };

export type ToplevelAction =
  | "activate"
  | "close"
  | "minimize"
  | "unminimize"
  | "maximize"
  | "unmaximize";
