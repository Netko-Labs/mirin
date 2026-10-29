/**
 * Radix `RadioGroup` on Metal: a `role="radiogroup"` container holding one
 * value; each `Item` is a `role="radio"` button with
 * `data-state="checked" | "unchecked"` and an `Indicator` shown while checked.
 */

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
} from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";
import { useFormField } from "../runtime/form.tsx";
import { useLabelTarget } from "./label.tsx";
import { stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface RadioGroupApi {
  value: string;
  setValue: (value: string) => void;
  disabled: boolean;
}

const RadioGroupContext = createContext<RadioGroupApi>({
  value: "",
  setValue: () => {},
  disabled: false,
});
const ItemContext = createContext<{ checked: boolean; disabled: boolean }>({
  checked: false,
  disabled: false,
});

export interface RootProps extends Props {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
}

function Root({
  asChild,
  value,
  defaultValue = "",
  onValueChange,
  disabled = false,
  orientation,
  required: _r,
  name,
  loop: _l,
  dir: _d,
  ...props
}: RootProps) {
  const [current, setCurrent] = useControllableState({
    prop: value,
    defaultProp: defaultValue,
    onChange: onValueChange,
  });
  // metal: radix's hidden bubble inputs, so a named group submits with its form.
  useFormField(
    typeof name === "string" ? name : undefined,
    current && !disabled ? current : undefined,
  );
  const shared: Props = {
    ...props,
    role: "radiogroup",
    "aria-orientation": orientation,
    "data-orientation": orientation,
    "data-disabled": disabled ? "" : undefined,
  };
  return (
    <RadioGroupContext.Provider value={{ value: current, setValue: setCurrent, disabled }}>
      {asChild ? <Slot {...shared} /> : <div {...shared} />}
    </RadioGroupContext.Provider>
  );
}

function Item({
  asChild,
  value,
  disabled: own = false,
  onClick,
  children,
  ...props
}: Props & { value: string; disabled?: boolean }) {
  const group = useContext(RadioGroupContext);
  const disabled = group.disabled || own;
  const checked = group.value === value;
  const select = useCallback(() => {
    if (!disabled) group.setValue(value);
  }, [disabled, group, value]);
  useLabelTarget(props.id, select);
  const shared: Props = {
    ...props,
    type: "button",
    role: "radio",
    value,
    "aria-checked": checked,
    "data-state": checked ? "checked" : "unchecked",
    "data-disabled": disabled ? "" : undefined,
    disabled,
    // metal: center the indicator (the web centers it with translate).
    viewStyle: { alignItems: "center", justifyContent: "center" },
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented) select();
    },
  };
  return (
    <ItemContext.Provider value={{ checked, disabled }}>
      {asChild ? <Slot {...shared}>{children}</Slot> : <button {...shared}>{children}</button>}
    </ItemContext.Provider>
  );
}

function Indicator({ asChild, forceMount, className, children, style, ...props }: Props) {
  const { checked, disabled } = useContext(ItemContext);
  if (!checked && !forceMount) return null;
  // metal: the upstream dot is centered with absolute + translate; drop the
  // placement classes and let the indicator's flex centering place it.
  const placed = Children.map(children, (child) =>
    isValidElement<{ className?: string }>(child)
      ? cloneElement(child, { className: stripPlacement(child.props.className) })
      : child,
  );
  const shared: Props = {
    ...props,
    className: stripPlacement(className),
    "data-state": checked ? "checked" : "unchecked",
    "data-disabled": disabled ? "" : undefined,
    style: { width: "100%", height: "100%", ...(style as Record<string, unknown>) },
  };
  return asChild ? <Slot {...shared}>{placed}</Slot> : <span {...shared}>{placed}</span>;
}

export const RadioGroup = { Root, Item, Indicator };
