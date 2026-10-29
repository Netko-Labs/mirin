import { Text, View } from "@mirinjs/metal";
import { useTheme } from "../theme.ts";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  testID?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled = false, testID }: CheckboxProps) {
  const theme = useTheme();
  return (
    <View
      onPress={() => {
        if (!disabled) onCheckedChange?.(!checked);
      }}
      testID={testID}
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: checked ? theme.colors.primary : theme.colors.input,
        backgroundColor: checked ? theme.colors.primary : undefined,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {checked ? (
        <Text style={{ color: theme.colors.primaryForeground, fontSize: 11, fontWeight: "bold" }}>
          ✓
        </Text>
      ) : null}
    </View>
  );
}
