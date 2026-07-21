/**
 * Public types for the alpha native renderer: React components take normal
 * flexbox-flavored styles; the renderer translates them into the GPUI element
 * tree (crates/mirin-native) where GPUI's own flex engine lays them out.
 */

import type { ReactNode } from "react";

/** Flexbox-flavored layout + appearance for a `<View>` (v1 subset). */
export interface ViewStyle {
  flexDirection?: "row" | "column";
  gap?: number;
  padding?: number;
  width?: number;
  height?: number;
  /** `flex: 1` fills the parent (maps to the native `fill`). */
  flex?: number;
  alignItems?: "center";
  justifyContent?: "center";
  /** `#RGB` or `#RRGGBB`. */
  backgroundColor?: string;
  borderRadius?: number;
}

/** Appearance for a `<Text>` (v1 subset). */
export interface TextStyle {
  /** `#RGB` or `#RRGGBB`. */
  color?: string;
  fontSize?: number;
}

export interface ViewProps {
  style?: ViewStyle;
  onPress?: () => void;
  children?: ReactNode;
}

export interface TextProps {
  style?: TextStyle;
  children?: ReactNode;
}

/** An interaction event coming back from the native UI. */
export interface NativeEvent {
  type: "press";
  nodeId: string;
}

/**
 * The channel to the native renderer. `spawnNativeHost` provides the stdio
 * implementation; the eventual FFI wiring will provide an in-process one.
 */
export interface NativeTransport {
  send(treeJson: string): void;
  onEvent(listener: (event: NativeEvent) => void): void;
  close(): void;
}

/** A mounted native React root. */
export interface NativeRoot {
  unmount(): void;
}
