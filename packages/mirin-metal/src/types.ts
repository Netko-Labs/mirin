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
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  alignSelf?: "flex-start" | "center" | "flex-end" | "stretch";
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

/** Appearance for a `<Text>`. */
export interface TextStyle {
  color?: Color;
  fontSize?: number;
  fontWeight?: "normal" | "500" | "600" | "700" | "medium" | "semibold" | "bold";
  /** `"monospace"` picks the system monospace family; anything else is the default. */
  fontFamily?: "monospace" | "default";
  opacity?: number;
  textAlign?: "left" | "center" | "right";
  fontStyle?: "normal" | "italic";
  textDecorationLine?: "none" | "underline" | "line-through";
  lineHeight?: number;
}

/** Appearance for a `<TextInput>`. */
export interface TextInputStyle {
  color?: Color;
  placeholderColor?: Color;
  fontSize?: number;
  fontFamily?: "monospace" | "default";
  backgroundColor?: Color;
  padding?: number;
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
}

/** The modifier keys held during a press or a right-click (`super` is the Super, ❖, key). */
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
  /** Receives the mounted host instance (usable as a `createPortal` target). */
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
  /** Stop pointer events, the wheel included, from reaching views painted underneath (overlays). */
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
   * lifts. The innermost `onPointer` view under the pointer captures it.
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
   * Drag these files out of the window: a press here and a move of a few
   * pixels starts it, and any app's window that takes files gets them (this
   * one's `onDrop` views included). A click without moving is still a press.
   */
  dragFiles?: DragFiles;
  /** Files dragged over this view or dropped on it. */
  onDrop?: (event: DropInfo) => void;
  /** Stable handle for checks and tools (`root.nodeId(testID)`); never rendered. */
  testID?: string;
  children?: ReactNode;
}

export interface TextProps {
  style?: TextStyle;
  /** Keep on one line and cut with an ellipsis instead of wrapping. */
  numberOfLines?: 1;
  children?: ReactNode;
}

export interface TextInputProps extends AccessibilityProps {
  /** Controlled value; a change resets the native buffer. */
  value: string;
  /**
   * Bump it to reset the native buffer to `value` even when `value` didn't change: after
   * refusing an edit (a key the app took for itself), so the field shows `value` again.
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
   * Navigation keys the input doesn't use itself (a launcher's list): Escape, and
   * ArrowUp / ArrowDown in a single-line field (a multiline one moves its caret).
   */
  onKeyPress?: (key: "Escape" | "ArrowUp" | "ArrowDown") => void;
  /**
   * Controlled caret and selection, as React Native's: offsets into `value` (JavaScript
   * string indices). When it changes, or the native buffer is reset, the field selects
   * it; `start` is where the selection begins and `end` where the caret is.
   */
  selection?: TextSelection;
  /** The caret moved or the selection changed (by keys, the pointer, or `selection`). */
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
  fontWeight?: "normal" | "medium" | "semibold" | "bold";
  fontStyle?: "normal" | "italic";
  textDecorationLine?: "none" | "underline" | "line-through";
  /** Draws every paragraph the run is in at this size (a heading); a line has one size. */
  fontSize?: number;
  /** A press on the run is reported (`onRunPress`) instead of placing the caret: a checkbox in the text. */
  press?: boolean;
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

export interface ImageProps {
  /** Absolute path to a local image file. */
  source: string;
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
  | { type: "change"; nodeId: string; value: string }
  | { type: "submit"; nodeId: string; value: string }
  | { type: "key"; nodeId: string; value: "Escape" | "ArrowUp" | "ArrowDown" }
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
  | ({ type: "wheel"; nodeId: string } & WheelInfo)
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
  /** Scroll a scrollable node down by `dy` px (negative scrolls up). */
  | { kind: "scroll"; id: string; dy: number }
  | { kind: "window"; action: "zoom" | "minimize" };

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
