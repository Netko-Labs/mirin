import { View } from "@mirinjs/metal";
import { useTheme } from "../theme.ts";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  testID?: string;
}

export function Switch({ checked, onCheckedChange, disabled = false, testID }: SwitchProps) {
  const theme = useTheme();
  return (
    <View
      onPress={() => {
        if (!disabled) onCheckedChange?.(!checked);
      }}
      testID={testID}
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        padding: 2,
        flexDirection: "row",
        justifyContent: checked ? "flex-end" : "flex-start",
        backgroundColor: checked ? theme.colors.primary : theme.colors.input,
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 999,
          backgroundColor: checked ? theme.colors.primaryForeground : theme.colors.foreground,
        }}
      />
    </View>
  );
}
