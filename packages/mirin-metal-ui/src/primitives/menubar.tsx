/**
 * Radix `Menubar` on Metal: the root holds which menu is open (by value);
 * each `Menubar.Menu` is a menu whose trigger toggles it on press and, while
 * another menu of the bar is open, takes over on hover. The open menu's
 * dismiss layer leaves a hole over the bar so the other triggers stay live.
 */

import type { Bounds } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState, useStableId } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";
import {
  type MenuApi,
  MenuCheckboxItem,
  MenuContent,
  type MenuContentProps,
  MenuContext,
  MenuGroup,
  MenuItem,
  MenuItemIndicator,
  MenuLabel,
  MenuPortal,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  useMenu,
} from "./menu.tsx";
import { boundsOf, dataState } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface BarApi {
  value: string;
  setValue: (value: string) => void;
  bounds: Bounds | null;
}

const BarContext = createContext<BarApi | null>(null);

function useBar(): BarApi {
  const bar = useContext(BarContext);
  if (!bar) throw new Error("Menubar parts must be inside <Menubar.Root>");
  return bar;
}

function Root({
  value,
  defaultValue = "",
  onValueChange,
  loop: _loop,
  dir: _dir,
  ...props
}: Props & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  loop?: boolean;
  dir?: string;
}) {
  const [open, setOpen] = useControllableState({
    prop: value,
    defaultProp: defaultValue,
    onChange: onValueChange,
  });
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const shared: Props = { role: "menubar", ...props, onLayout: setBounds };
  return (
    <BarContext.Provider value={{ value: open, setValue: setOpen, bounds }}>
      <div {...shared} />
    </BarContext.Provider>
  );
}

/** Per-menu id the trigger and content share. */
const MenuIdContext = createContext("");

function Menu({ value, children }: { value?: string; children?: ReactNode }) {
  const bar = useBar();
  const generated = useStableId("menubar-menu");
  const id = value ?? generated;
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const open = bar.value === id;
  const api: MenuApi = {
    open,
    setOpen: (next) => bar.setValue(next ? id : ""),
    anchor,
    setAnchor,
    closeAll: () => bar.setValue(""),
  };
  return (
    <MenuIdContext.Provider value={id}>
      <MenuContext.Provider value={api}>{children}</MenuContext.Provider>
    </MenuIdContext.Provider>
  );
}

function Trigger({
  asChild,
  disabled,
  onClick,
  onMouseEnter,
  ...props
}: Props & { disabled?: boolean }) {
  const bar = useBar();
  const menu = useMenu();
  const id = useContext(MenuIdContext);
  const shared: Props = {
    ...props,
    role: "menuitem",
    disabled,
    "data-state": dataState(menu.open),
    "data-disabled": disabled ? "" : undefined,
    "aria-expanded": menu.open,
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (event.defaultPrevented || disabled) return;
      menu.setAnchor(boundsOf(event));
      menu.setOpen(!menu.open);
    },
    onMouseEnter: (event: SyntheticEvent) => {
      (onMouseEnter as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (disabled || bar.value === "" || bar.value === id) return;
      menu.setAnchor(boundsOf(event));
      menu.setOpen(true);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Content(props: MenuContentProps) {
  const bar = useBar();
  return <MenuContent side="bottom" align="start" dismissAround={bar.bounds} {...props} />;
}

export const Menubar = {
  Root,
  Menu,
  Trigger,
  Portal: MenuPortal,
  Content,
  Group: MenuGroup,
  Label: MenuLabel,
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  ItemIndicator: MenuItemIndicator,
  Separator: MenuSeparator,
  Sub: MenuSub,
  SubTrigger: MenuSubTrigger,
  SubContent: MenuSubContent,
};
