import { View } from "@mirinjs/metal";
import { useTheme } from "../theme.ts";

export interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
  className?: string;
  decorative?: boolean;
}

export function Separator({ orientation = "horizontal" }: SeparatorProps) {
  const theme = useTheme();
  return (
    <View
      style={
        orientation === "horizontal"
          ? { height: 1, flexShrink: 0, backgroundColor: theme.colors.border }
          : { width: 1, flexShrink: 0, backgroundColor: theme.colors.border }
      }
    />
  );
}
