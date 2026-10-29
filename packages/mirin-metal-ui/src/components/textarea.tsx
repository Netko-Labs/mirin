import { TextInput, type TextInputStyle } from "@mirinjs/metal";
import { useMemo } from "react";
import { useTheme } from "../theme.ts";
import { tw } from "../tw.ts";

const TEXTAREA_CLASSES =
  "min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm";

export interface TextareaProps {
  className?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  rows?: number;
  onChange?: (event: { target: { value: string } }) => void;
  onChangeText?: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmitEditing?: (value: string) => void;
  style?: TextInputStyle;
  testID?: string;
}

export function Textarea({
  className,
  value,
  placeholder,
  disabled = false,
  autoFocus,
  rows,
  onChange,
  onChangeText,
  onSubmitEditing,
  style,
  testID,
}: TextareaProps) {
  const theme = useTheme();
  const { input } = useMemo(
    () => tw(theme.colors, TEXTAREA_CLASSES, className),
    [theme, className],
  );
  return (
    <TextInput
      value={value}
      placeholder={placeholder}
      multiline
      autoFocus={autoFocus}
      onChangeText={(text) => {
        if (disabled) return;
        onChangeText?.(text);
        onChange?.({ target: { value: text } });
      }}
      onSubmitEditing={onSubmitEditing}
      style={{
        color: theme.colors.foreground,
        placeholderColor: theme.colors.mutedForeground,
        focusBorderColor: theme.colors.ring,
        padding: 10,
        ...(rows ? { minHeight: rows * 22 } : {}),
        ...input,
        ...style,
      }}
      testID={testID}
    />
  );
}
