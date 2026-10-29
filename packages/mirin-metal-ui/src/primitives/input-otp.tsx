/**
 * Stand-in for the `input-otp` package on Metal: `OTPInput` renders its
 * slots (children or `render`) with a transparent text field laid over them
 * that takes the typing, and publishes per-slot state through
 * `OTPInputContext` (`slots[i].char`, `isActive`, `hasFakeCaret`).
 */

import { TextInput, View } from "@mirinjs/metal";
import { createContext, type ReactNode, useState } from "react";
import { cn } from "../lib/cn.ts";
import { useControllableState } from "../lib/state.ts";

export const REGEXP_ONLY_DIGITS = "^\\d+$";
export const REGEXP_ONLY_CHARS = "^[a-zA-Z]+$";
export const REGEXP_ONLY_DIGITS_AND_CHARS = "^[a-zA-Z0-9]+$";

export interface SlotProps {
  isActive: boolean;
  char: string | null;
  placeholderChar: string | null;
  hasFakeCaret: boolean;
}

export interface RenderProps {
  slots: SlotProps[];
  isFocused: boolean;
  isHovering: boolean;
}

export const OTPInputContext = createContext<RenderProps>({
  slots: [],
  isFocused: false,
  isHovering: false,
});

export interface OTPInputProps {
  maxLength: number;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
  pattern?: string | RegExp;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  containerClassName?: string;
  className?: string;
  render?: (props: RenderProps) => ReactNode;
  children?: ReactNode;
  [prop: string]: unknown;
}

const TRANSPARENT = "#00000000";

export function OTPInput({
  maxLength,
  value,
  defaultValue = "",
  onChange,
  onComplete,
  pattern,
  placeholder,
  disabled = false,
  autoFocus = false,
  containerClassName,
  className: _c,
  render,
  children,
  textAlign: _t,
  inputMode: _i,
  pushPasswordManagerStrategy: _p,
  noScriptCSSFallback: _n,
  ...props
}: OTPInputProps): ReactNode {
  const [current, setCurrent] = useControllableState({
    prop: value,
    defaultProp: defaultValue,
    onChange,
  });
  // metal: there are no focus events yet; the field counts as focused once
  // it is pressed or typed into (or with `autoFocus`).
  const [focused, setFocused] = useState(autoFocus);
  const regex = pattern === undefined ? undefined : new RegExp(pattern);

  const accept = (text: string) => {
    if (disabled) return;
    const next = text.slice(0, maxLength);
    setFocused(true);
    if (next !== "" && regex && !regex.test(next)) return;
    setCurrent(next);
    if (next.length === maxLength && next !== current) onComplete?.(next);
  };

  const active = Math.min(current.length, maxLength - 1);
  const slots: SlotProps[] = Array.from({ length: maxLength }, (_, index) => ({
    char: current[index] ?? null,
    placeholderChar: placeholder?.[index] ?? null,
    isActive: focused && !disabled && index === active,
    hasFakeCaret: focused && !disabled && index === active && current.length < maxLength,
  }));
  const state: RenderProps = { slots, isFocused: focused, isHovering: false };
  const testID =
    (typeof props["data-testid"] === "string" ? props["data-testid"] : undefined) ??
    (typeof props.id === "string" ? props.id : undefined) ??
    (typeof props["data-slot"] === "string" ? props["data-slot"] : undefined);

  return (
    <OTPInputContext.Provider value={state}>
      <div
        className={cn("relative", containerClassName)}
        data-input-otp-container=""
        aria-disabled={disabled ? "true" : undefined}
      >
        {render ? render(state) : children}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: "column",
          }}
        >
          <TextInput
            value={current}
            testID={testID}
            autoFocus={autoFocus}
            style={{
              flex: 1,
              color: TRANSPARENT,
              placeholderColor: TRANSPARENT,
              backgroundColor: TRANSPARENT,
              borderColor: TRANSPARENT,
              focusBorderColor: TRANSPARENT,
            }}
            onChangeText={accept}
          />
        </View>
      </div>
    </OTPInputContext.Provider>
  );
}
