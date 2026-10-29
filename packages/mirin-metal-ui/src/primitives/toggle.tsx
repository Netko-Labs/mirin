/** Radix `Toggle` on Metal: a two-state button with `data-state="on" | "off"`. */

import type { ReactNode } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

export interface RootProps extends Props {
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  disabled?: boolean;
}

function Root({
  asChild,
  pressed,
  defaultPressed = false,
  onPressedChange,
  disabled = false,
  onClick,
  ...props
}: RootProps) {
  const [on, setOn] = useControllableState({
    prop: pressed,
    defaultProp: defaultPressed,
    onChange: onPressedChange,
  });
  const shared: Props = {
    ...props,
    type: "button",
    "aria-pressed": on,
    "data-state": on ? "on" : "off",
    "data-disabled": disabled ? "" : undefined,
    disabled,
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented && !disabled) setOn(!on);
    },
  };
  return asChild ? <Slot {...shared} /> : <button {...shared} />;
}

export const Toggle = { Root };
