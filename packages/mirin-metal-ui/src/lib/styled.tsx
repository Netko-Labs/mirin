/**
 * Internal primitives every component is built from: a `Box` (Metal `View`)
 * and a `Txt` (Metal `Text`) that take shadcn-style `className` strings,
 * translate them through the theme, and let text styling flow down the tree
 * the way CSS inheritance does on the web.
 */

import { Text, type TextStyle, View, type ViewStyle } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useTheme } from "../theme.ts";
import { tw } from "../tw.ts";

const InheritedText = createContext<TextStyle>({});

export interface BoxProps {
  className?: string;
  style?: ViewStyle;
  children?: ReactNode;
  onPress?: () => void;
  onHoverChange?: (hovered: boolean) => void;
  testID?: string;
}

export function Box({ className, style, children, onPress, onHoverChange, testID }: BoxProps) {
  const theme = useTheme();
  const inherited = useContext(InheritedText);
  const { view, text } = useMemo(() => tw(theme.colors, className), [theme, className]);
  const merged = useMemo(() => ({ ...inherited, ...text }), [inherited, text]);
  const body = (
    <View
      style={{ ...view, ...style }}
      onPress={onPress}
      onHoverChange={onHoverChange}
      testID={testID}
    >
      {children}
    </View>
  );
  return Object.keys(text).length > 0 ? (
    <InheritedText.Provider value={merged}>{body}</InheritedText.Provider>
  ) : (
    body
  );
}

export interface TxtProps {
  className?: string;
  style?: TextStyle;
  children?: ReactNode;
  numberOfLines?: 1;
}

export function Txt({ className, style, children, numberOfLines }: TxtProps) {
  const theme = useTheme();
  const inherited = useContext(InheritedText);
  const { text } = useMemo(() => tw(theme.colors, className), [theme, className]);
  const truncate = numberOfLines === 1 || /\b(truncate|whitespace-nowrap)\b/.test(className ?? "");
  return (
    <Text
      numberOfLines={truncate ? 1 : undefined}
      style={{ color: theme.colors.foreground, ...inherited, ...text, ...style }}
    >
      {children}
    </Text>
  );
}

/** Render children as text when they are strings, otherwise as-is. */
export function Content({ children, className }: { children?: ReactNode; className?: string }) {
  if (typeof children === "string" || typeof children === "number") {
    return <Txt className={className}>{String(children)}</Txt>;
  }
  if (
    Array.isArray(children) &&
    children.every((c) => typeof c === "string" || typeof c === "number")
  ) {
    return <Txt className={className}>{children.join("")}</Txt>;
  }
  return <>{children}</>;
}

export function useInheritedText(): TextStyle {
  return useContext(InheritedText);
}
