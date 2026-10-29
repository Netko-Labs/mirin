import { TextInput, type TextInputStyle } from "@mirinjs/metal";
import { useMemo } from "react";
import { cn } from "../lib/cn.ts";
import { useTheme } from "../theme.ts";
import { tw } from "../tw.ts";

const INPUT_CLASSES =
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm";

export interface InputProps {
  className?: string;
  value: string;
  placeholder?: string;
  type?: "text" | "password" | "email" | "number" | "search" | "url";
  disabled?: boolean;
  autoFocus?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  /** React Native alias for `onChange`. */
  onChangeText?: (value: string) => void;
  onSubmitEditing?: (value: string) => void;
  style?: TextInputStyle;
  testID?: string;
}

export function Input({
  className,
  value,
  placeholder,
  type = "text",
  disabled = false,
  autoFocus,
  onChange,
  onChangeText,
  onSubmitEditing,
  style,
  testID,
}: InputProps) {
  const theme = useTheme();
  const { input } = useMemo(() => tw(theme.colors, INPUT_CLASSES, className), [theme, className]);
  return (
    <TextInput
      value={value}
      placeholder={placeholder}
      secureTextEntry={type === "password"}
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
        padding: 8,
        ...input,
        ...(disabled ? { color: theme.colors.mutedForeground } : {}),
        ...style,
      }}
      testID={testID}
    />
  );
}

export const inputClassName = cn;
