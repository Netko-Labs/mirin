/**
 * Radix `Accordion` on Metal: same part names and props. `type="single"`
 * keeps at most one item open (`collapsible` lets it close again);
 * `type="multiple"` keeps a list. Item, header, trigger, and content carry
 * `data-state`; content renders only while its item is open.
 */

import { createContext, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";
import { dataState } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface AccordionApi {
  isOpen: (value: string) => boolean;
  toggle: (value: string) => void;
  disabled: boolean;
  orientation: "vertical" | "horizontal";
}

const AccordionContext = createContext<AccordionApi | null>(null);

function useAccordion(): AccordionApi {
  const api = useContext(AccordionContext);
  if (!api) throw new Error("Accordion parts must be inside <Accordion.Root>");
  return api;
}

interface ItemApi {
  value: string;
  open: boolean;
  disabled: boolean;
}

const ItemContext = createContext<ItemApi | null>(null);

function useItem(): ItemApi {
  const api = useContext(ItemContext);
  if (!api) throw new Error("Accordion parts must be inside <Accordion.Item>");
  return api;
}

export type RootProps = Props & {
  type?: "single" | "multiple";
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: ((value: string) => void) | ((value: string[]) => void);
  collapsible?: boolean;
  disabled?: boolean;
  orientation?: "vertical" | "horizontal";
  dir?: "ltr" | "rtl";
};

function toList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return value === "" ? [] : [value];
}

function Root({
  type = "single",
  value,
  defaultValue,
  onValueChange,
  collapsible = false,
  disabled = false,
  orientation = "vertical",
  dir: _dir,
  asChild,
  ...props
}: RootProps) {
  const multiple = type === "multiple";
  const [open, setOpen] = useControllableState<string[]>({
    prop: toList(value),
    defaultProp: toList(defaultValue) ?? [],
    onChange: (next) => {
      const emit = onValueChange as ((v: string | string[]) => void) | undefined;
      emit?.(multiple ? next : (next[0] ?? ""));
    },
  });
  const api: AccordionApi = {
    isOpen: (item) => open.includes(item),
    toggle: (item) => {
      const isOpen = open.includes(item);
      if (multiple) {
        setOpen(isOpen ? open.filter((entry) => entry !== item) : [...open, item]);
      } else if (!isOpen) {
        setOpen([item]);
      } else if (collapsible) {
        setOpen([]);
      }
    },
    disabled,
    orientation,
  };
  const shared: Props = { ...props, "data-orientation": orientation };
  return (
    <AccordionContext.Provider value={api}>
      {asChild ? <Slot {...shared} /> : <div {...shared} />}
    </AccordionContext.Provider>
  );
}

function Item({
  value,
  disabled,
  asChild,
  ...props
}: Props & { value: string; disabled?: boolean }) {
  const accordion = useAccordion();
  const open = accordion.isOpen(value);
  const isDisabled = disabled === true || accordion.disabled;
  const shared: Props = {
    ...props,
    "data-state": dataState(open),
    "data-orientation": accordion.orientation,
    ...(isDisabled ? { "data-disabled": "" } : {}),
  };
  return (
    <ItemContext.Provider value={{ value, open, disabled: isDisabled }}>
      {asChild ? <Slot {...shared} /> : <div {...shared} />}
    </ItemContext.Provider>
  );
}

function Header({ asChild, ...props }: Props) {
  const item = useItem();
  const shared: Props = {
    ...props,
    "data-state": dataState(item.open),
    ...(item.disabled ? { "data-disabled": "" } : {}),
  };
  return asChild ? <Slot {...shared} /> : <h3 {...shared} />;
}

function Trigger({ asChild, onClick, ...props }: Props) {
  const accordion = useAccordion();
  const item = useItem();
  const shared: Props = {
    ...props,
    "data-state": dataState(item.open),
    "aria-expanded": item.open,
    disabled: item.disabled || undefined,
    ...(item.disabled ? { "data-disabled": "" } : {}),
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented) accordion.toggle(item.value);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Content({ asChild, forceMount, ...props }: Props & { forceMount?: boolean }) {
  const item = useItem();
  if (!item.open && !forceMount) return null;
  const shared: Props = {
    ...props,
    role: "region",
    "data-state": dataState(item.open),
    ...(item.disabled ? { "data-disabled": "" } : {}),
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export const Accordion = { Root, Item, Header, Trigger, Content };
