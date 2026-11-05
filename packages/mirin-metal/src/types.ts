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

export interface ViewProps {
  /** Receives the mounted host instance (usable as a `createPortal` target). */
  ref?: Ref<unknown>;
  style?: ViewStyle;
  /**
   * Style for strings placed directly in this view (for example, a string a
   * child component returns). Without it they render with default styling.
   */
  textStyle?: TextStyle;
  /** Click/tap. `bounds` is the view's painted rect, for anchoring popups. */
  onPress?: (event: { bounds?: Bounds }) => void;
  /** Pointer entered (`true`) or left (`false`) the view. */
  onHoverChange?: (hovered: boolean, bounds?: Bounds) => void;
  /** Stop pointer events from reaching views painted underneath (overlays). */
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
  /** Press on this view, then every move and the release until the button lifts. */
  onPointer?: (event: PointerInfo) => void;
  /** Right-click, in window pixels. */
  onContextMenu?: (event: { x: number; y: number }) => void;
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

export interface TextInputProps {
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
  /** Navigation keys the input doesn't use itself (a launcher's list). */
  onKeyPress?: (key: "Escape" | "ArrowUp" | "ArrowDown") => void;
  /** Stable handle for checks and tools (`root.nodeId(testID)`); never rendered. */
  testID?: string;
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
  | { type: "press"; nodeId: string; bounds?: Bounds }
  | { type: "change"; nodeId: string; value: string }
  | { type: "submit"; nodeId: string; value: string }
  | { type: "key"; nodeId: string; value: "Escape" | "ArrowUp" | "ArrowDown" }
  | { type: "hover"; nodeId: string; hovered: boolean; bounds?: Bounds }
  | ({ type: "pointer"; nodeId: string } & PointerInfo)
  | { type: "contextmenu"; nodeId: string; x: number; y: number }
  | ({ type: "keydown"; nodeId: string } & KeyDownInfo)
  | ({ type: "wheel"; nodeId: string } & WheelInfo)
  | ({ type: "drop"; nodeId: string } & DropInfo)
  | { type: "resize"; nodeId: string; bounds: Bounds }
  | { type: "layout"; nodeId: "root"; nodes: LayoutNode[] }
  | ({ type: "chrome"; nodeId: "root" } & WindowChrome)
  /** A newly opened window painted its first frame (once per open). */
  | { type: "frame"; nodeId: "root" };

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
