/**
 * Radix `Collapsible` on Metal: same part names and props (`Trigger` and
 * `Content`, also exported as `CollapsibleTrigger`/`CollapsibleContent`).
 * Content renders only while open (unless `forceMount`).
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

interface CollapsibleApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
}

const CollapsibleContext = createContext<CollapsibleApi>({
  open: false,
  setOpen: () => {},
  disabled: false,
});

export type RootProps = Props & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
};

function Root({ open, defaultOpen = false, onOpenChange, disabled, asChild, ...props }: RootProps) {
  const [value, setValue] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const isDisabled = disabled === true;
  const shared: Props = {
    ...props,
    "data-state": dataState(value),
    ...(isDisabled ? { "data-disabled": "" } : {}),
  };
  return (
    <CollapsibleContext.Provider value={{ open: value, setOpen: setValue, disabled: isDisabled }}>
      {asChild ? <Slot {...shared} /> : <div {...shared} />}
    </CollapsibleContext.Provider>
  );
}

function Trigger({ asChild, onClick, ...props }: Props) {
  const collapsible = useContext(CollapsibleContext);
  const shared: Props = {
    ...props,
    "data-state": dataState(collapsible.open),
    "aria-expanded": collapsible.open,
    disabled: collapsible.disabled || undefined,
    ...(collapsible.disabled ? { "data-disabled": "" } : {}),
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented) collapsible.setOpen(!collapsible.open);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Content({ asChild, forceMount, ...props }: Props & { forceMount?: boolean }) {
  const collapsible = useContext(CollapsibleContext);
  if (!collapsible.open && !forceMount) return null;
  const shared: Props = {
    ...props,
    "data-state": dataState(collapsible.open),
    ...(collapsible.disabled ? { "data-disabled": "" } : {}),
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export const Collapsible = {
  Root,
  Trigger,
  Content,
  CollapsibleTrigger: Trigger,
  CollapsibleContent: Content,
};
