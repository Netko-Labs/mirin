/**
 * Radix `Checkbox` on Metal: a `role="checkbox"` button with
 * `data-state="checked" | "unchecked" | "indeterminate"`; the `Indicator`
 * renders only while checked (or indeterminate).
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

export type CheckedState = boolean | "indeterminate";

const CheckboxContext = createContext<{ checked: CheckedState; disabled: boolean }>({
  checked: false,
  disabled: false,
});

function stateOf(checked: CheckedState): string {
  return checked === "indeterminate" ? "indeterminate" : checked ? "checked" : "unchecked";
}

export interface RootProps extends Props {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
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
  const [state, setState] = useControllableState<CheckedState>({
    prop: checked,
    defaultProp: defaultChecked,
    onChange: onCheckedChange,
  });
  // metal: radix's hidden bubble input, so a named checkbox submits with its form.
  useFormField(name, state === true && !disabled ? (value ?? "on") : undefined);
  const toggle = useCallback(() => {
    if (!disabled) setState((previous) => (previous === "indeterminate" ? true : !previous));
  }, [disabled, setState]);
  useLabelTarget(props.id, toggle);
  const shared: Props = {
    ...props,
    type: "button",
    role: "checkbox",
    "aria-checked": state === "indeterminate" ? "mixed" : state,
    "data-state": stateOf(state),
    "data-disabled": disabled ? "" : undefined,
    disabled,
    value: value ?? "on",
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented) toggle();
    },
  };
  return (
    <CheckboxContext.Provider value={{ checked: state, disabled }}>
      {asChild ? <Slot {...shared}>{children}</Slot> : <button {...shared}>{children}</button>}
    </CheckboxContext.Provider>
  );
}

function Indicator({ asChild, forceMount, style, ...props }: Props) {
  const { checked, disabled } = useContext(CheckboxContext);
  if (!checked && !forceMount) return null;
  const shared: Props = {
    ...props,
    "data-state": stateOf(checked),
    "data-disabled": disabled ? "" : undefined,
    // metal: fill the box so the indicator's centering classes center the icon.
    style: { width: "100%", height: "100%", ...(style as Record<string, unknown>) },
  };
  return asChild ? <Slot {...shared} /> : <span {...shared} />;
}

export const Checkbox = { Root, Indicator };
