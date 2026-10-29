import { View } from "@mirinjs/metal";
import { useMemo } from "react";
import { useTheme } from "../theme.ts";
import { tw } from "../tw.ts";

export interface ProgressProps {
  /** 0..100 */
  value?: number;
  className?: string;
}

export function Progress({ value = 0, className }: ProgressProps) {
  const theme = useTheme();
  const { view } = useMemo(() => tw(theme.colors, className), [theme, className]);
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <View
      style={{
        flexDirection: "row",
        height: 8,
        borderRadius: 999,
        overflow: "hidden",
        backgroundColor: `${theme.colors.primary}33`,
        ...view,
      }}
    >
      <View style={{ flex: clamped > 0 ? clamped : 0, backgroundColor: theme.colors.primary }} />
      <View style={{ flex: clamped < 100 ? 100 - clamped : 0 }} />
    </View>
  );
}
