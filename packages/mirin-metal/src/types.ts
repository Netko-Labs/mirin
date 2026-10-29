/**
 * Public types for the Metal renderer: React components take React Native-
 * flavored props; the renderer translates them into the GPUI element tree
 * (crates/mirin-metal `tree.rs`) where GPUI's own flex engine lays them out.
 */

import type { ReactNode } from "react";

/** `#RGB`, `#RRGGBB`, or `#RRGGBBAA`. */
export type Color = string;

/** Flexbox-flavored layout + appearance for a `<View>`. */
export interface ViewStyle {
  flexDirection?: "row" | "column";
  gap?: number;
  padding?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** `absolute` takes the view out of flow, anchored to the nearest `relative` ancestor. */
  position?: "relative" | "absolute";
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  /** `flex: 1` grows into the remaining space (the native `flex`). */
  flex?: number;
  /** `flexShrink: 0` keeps the view from shrinking below its content. */
  flexShrink?: 0 | 1;
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  backgroundColor?: Color;
  /** Background while the pointer is over the view. */
  hoverBackgroundColor?: Color;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: Color;
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

export interface ViewProps {
  style?: ViewStyle;
  onPress?: () => void;
  /** Pointer entered (`true`) or left (`false`) the view. */
  onHoverChange?: (hovered: boolean) => void;
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
  | { type: "press"; nodeId: string }
  | { type: "change"; nodeId: string; value: string }
  | { type: "submit"; nodeId: string; value: string }
  | { type: "hover"; nodeId: string; hovered: boolean }
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
  | { kind: "layout" };

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
