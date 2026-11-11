/**
 * Radix `Switch` on Metal: a `role="switch"` button with
 * `data-state="checked" | "unchecked"` and a `Thumb` that slides to the end
 * while checked.
 */

import { createContext, type ReactNode, useCallback, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";
import { useFormField } from "../runtime/form.tsx";
import { useLabelTarget } from "./label.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

const SwitchContext = createContext<{ checked: boolean; disabled: boolean }>({
  checked: false,
  disabled: false,
});

export interface RootProps extends Props {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}

function Root({
  asChild,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  required: _r,
  name,
  value,
  onClick,
  children,
  ...props
}: RootProps) {
  const [on, setOn] = useControllableState({
    prop: checked,
    defaultProp: defaultChecked,
    onChange: onCheckedChange,
  });
  // metal: radix's hidden bubble input, so a named switch submits with its form.
  useFormField(
    typeof name === "string" ? name : undefined,
    on && !disabled ? (typeof value === "string" ? value : "on") : undefined,
  );
  const toggle = useCallback(() => {
    if (!disabled) setOn((previous) => !previous);
  }, [disabled, setOn]);
  useLabelTarget(props.id, toggle);
  const state = on ? "checked" : "unchecked";
  const shared: Props = {
    ...props,
    type: "button",
    role: "switch",
    value: value ?? "on",
    "aria-checked": on,
    "data-state": state,
    "data-disabled": disabled ? "" : undefined,
    disabled,
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented) toggle();
    },
  };
  return (
    <SwitchContext.Provider value={{ checked: on, disabled }}>
      {asChild ? <Slot {...shared}>{children}</Slot> : <button {...shared}>{children}</button>}
    </SwitchContext.Provider>
  );
}

function Thumb({ asChild, ...props }: Props) {
  const { checked, disabled } = useContext(SwitchContext);
  const shared: Props = {
    ...props,
    "data-state": checked ? "checked" : "unchecked",
    "data-disabled": disabled ? "" : undefined,
    // metal: translate-x is unsupported; an auto left margin pushes the
    // thumb to the end of the track while checked.
    viewStyle: { marginLeft: checked ? "auto" : 0 },
  };
  return asChild ? <Slot {...shared} /> : <span {...shared} />;
}

export const Switch = { Root, Thumb };
