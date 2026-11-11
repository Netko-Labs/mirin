/**
 * Radix `ToggleGroup` on Metal: `type="single"` holds one value (pressing
 * the active item clears it), `type="multiple"` holds a list. Items are
 * toggle buttons with `data-state="on" | "off"`.
 */

import { createContext, isValidElement, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface ToggleGroupApi {
  values: string[];
  toggle: (value: string) => void;
  disabled: boolean;
  type: "single" | "multiple";
  orientation?: string;
  /** Item values in render order, for `first:`/`last:` variants. */
  order: string[];
}

const ToggleGroupContext = createContext<ToggleGroupApi>({
  values: [],
  toggle: () => {},
  disabled: false,
  type: "single",
  order: [],
});

/** Values of descendant elements carrying a string `value` prop, in order. */
function itemValues(children: ReactNode): string[] {
  const list = Array.isArray(children) ? children.flat(Number.POSITIVE_INFINITY) : [children];
  return list.flatMap((child): string[] => {
    if (!isValidElement(child)) return [];
    const props = child.props as Props;
    if (typeof props.value === "string") return [props.value];
    return itemValues(props.children);
  });
}

export interface RootProps extends Props {
  type?: "single" | "multiple";
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: ((value: string) => void) | ((value: string[]) => void);
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
}

function toList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function Root({
  asChild,
  type = "single",
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  orientation,
  rovingFocus: _r,
  loop: _l,
  dir: _d,
  children,
  ...props
}: RootProps) {
  const [values, setValues] = useControllableState<string[]>({
    prop: toList(value),
    defaultProp: toList(defaultValue) ?? [],
    onChange: (next) => {
      if (type === "single") (onValueChange as ((v: string) => void) | undefined)?.(next[0] ?? "");
      else (onValueChange as ((v: string[]) => void) | undefined)?.(next);
    },
  });
  const toggle = (item: string) => {
    if (type === "single") setValues(values.includes(item) ? [] : [item]);
    else setValues(values.includes(item) ? values.filter((v) => v !== item) : [...values, item]);
  };
  // metal: upstream spaces items with `gap-[--spacing(var(--gap))]` and a
  // `--gap` custom property; read the property and apply the gap directly.
  const gap = (props.style as Record<string, unknown> | undefined)?.["--gap"];
  const shared: Props = {
    ...props,
    ...(typeof gap === "number" && gap > 0 ? { viewStyle: { gap: gap * 4 } } : {}),
    role: "group",
    "data-orientation": orientation,
    "data-disabled": disabled ? "" : undefined,
  };
  return (
    <ToggleGroupContext.Provider
      value={{ values, toggle, disabled, type, orientation, order: itemValues(children) }}
    >
      {asChild ? <Slot {...shared}>{children}</Slot> : <div {...shared}>{children}</div>}
    </ToggleGroupContext.Provider>
  );
}

function Item({
  asChild,
  value,
  disabled: own = false,
  onClick,
  ...props
}: Props & { value: string; disabled?: boolean }) {
  const group = useContext(ToggleGroupContext);
  const disabled = group.disabled || own;
  const on = group.values.includes(value);
  const shared: Props = {
    ...props,
    type: "button",
    ...(group.type === "single" ? { role: "radio", "aria-checked": on } : { "aria-pressed": on }),
    "data-state": on ? "on" : "off",
    "data-disabled": disabled ? "" : undefined,
    "data-orientation": group.orientation,
    // metal: items sit inside a context provider, so tell `first:`/`last:`
    // their position among the group's items explicitly.
    "data-metal-first": group.order[0] === value,
    "data-metal-last": group.order[group.order.length - 1] === value,
    disabled,
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented && !disabled) group.toggle(value);
    },
  };
  return asChild ? <Slot {...shared} /> : <button {...shared} />;
}

export const ToggleGroup = { Root, Item };
