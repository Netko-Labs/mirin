import { View } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box } from "../lib/styled.tsx";
import { useTheme } from "../theme.ts";

interface RadioApi {
  value: string | undefined;
  select: (value: string) => void;
}

const RadioContext = createContext<RadioApi>({ value: undefined, select: () => {} });

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children?: ReactNode;
}

export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
}: RadioGroupProps) {
  const [internal, setInternal] = useState(defaultValue);
  const current = value ?? internal;
  return (
    <RadioContext.Provider
      value={{
        value: current,
        select: (next) => {
          if (value === undefined) setInternal(next);
          onValueChange?.(next);
        },
      }}
    >
      <Box className={cn("flex flex-col gap-3", className)}>{children}</Box>
    </RadioContext.Provider>
  );
}

export function RadioGroupItem({
  value,
  disabled = false,
  testID,
}: {
  value: string;
  disabled?: boolean;
  className?: string;
  testID?: string;
}) {
  const theme = useTheme();
  const radio = useContext(RadioContext);
  const selected = radio.value === value;
  return (
    <View
      onPress={() => {
        if (!disabled) radio.select(value);
      }}
      testID={testID ?? `radio:${value}`}
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.input,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {selected ? (
        <View
          style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: theme.colors.primary }}
        />
      ) : null}
    </View>
  );
}
