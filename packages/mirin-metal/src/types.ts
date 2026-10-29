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
  /** Width / height, e.g. `16 / 9`. */
  aspectRatio?: number;
  flexWrap?: "nowrap" | "wrap";
  /** `absolute` takes the view out of flow, anchored to the nearest `relative` ancestor. */
  position?: "relative" | "absolute";
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
  width?: number;
  height?: number;
  minHeight?: number;
  flex?: number;
}

/** A pointer phase on a view with `onPointer`, in window pixels. */
export interface PointerInfo {
  phase: "down" | "move" | "up";
  x: number;
  y: number;
  /** The view's painted bounds when the event fired. */
  bounds?: Bounds;
}

/** Painted bounds of a node in window pixels. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewProps {
  /** Receives the mounted host instance (usable as a `createPortal` target). */
  ref?: Ref<unknown>;
  style?: ViewStyle;
  /** Click/tap. `bounds` is the view's painted rect, for anchoring popups. */
  onPress?: (event: { bounds?: Bounds }) => void;
  /** Pointer entered (`true`) or left (`false`) the view. */
  onHoverChange?: (hovered: boolean, bounds?: Bounds) => void;
  /** Stop pointer events from reaching views painted underneath (overlays). */
  occlude?: boolean;
  /** Called with the view's painted bounds whenever they change. */
  onLayout?: (bounds: Bounds) => void;
  /** Press on this view, then every move and the release until the button lifts. */
  onPointer?: (event: PointerInfo) => void;
  /** Right-click, in window pixels. */
  onContextMenu?: (event: { x: number; y: number }) => void;
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
  placeholder?: string;
  multiline?: boolean;
  /** Mask the text (passwords). */
  secureTextEntry?: boolean;
  autoFocus?: boolean;
  style?: TextInputStyle;
  onChangeText?: (text: string) => void;
  /** Enter (single line) or Ctrl/Cmd+Enter (multiline). */
  onSubmitEditing?: (text: string) => void;
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
  | { type: "hover"; nodeId: string; hovered: boolean; bounds?: Bounds }
  | ({ type: "pointer"; nodeId: string } & PointerInfo)
  | { type: "contextmenu"; nodeId: string; x: number; y: number }
  | { type: "resize"; nodeId: string; bounds: Bounds }
  | { type: "layout"; nodeId: "root"; nodes: LayoutNode[] };

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
