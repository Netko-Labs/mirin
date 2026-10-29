/**
 * Menu machinery shared by Radix `DropdownMenu`, `ContextMenu`, and
 * `Menubar`: a root holding open state and an anchor rect, content anchored
 * in the overlay layer, items that close the menu on select, checkbox/radio
 * items with indicators, and hover-opened submenus.
 */

import { type Bounds, View } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState, useStableId } from "../lib/state.ts";
import { DismissLayer, Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { type Align, boundsOf, dataState, type Side, stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};
type Handler<E = SyntheticEvent> = ((event: E) => void) | undefined;

export interface MenuApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: Bounds | null;
  setAnchor: (bounds: Bounds | null) => void;
  /** Close this menu and every menu it is nested in. */
  closeAll: () => void;
}

export const MenuContext = createContext<MenuApi | null>(null);

export function useMenu(): MenuApi {
  const api = useContext(MenuContext);
  if (!api) throw new Error("Menu parts must be inside a menu root");
  return api;
}

/** Which submenu of the current content is open. */
const SubSlotContext = createContext<{
  active: string | null;
  setActive: (id: string | null) => void;
}>({
  active: null,
  setActive: () => {},
});

export function MenuRoot({
  open,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  dir?: string;
  children?: ReactNode;
}) {
  const [value, setValue] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  return (
    <MenuContext.Provider
      value={{ open: value, setOpen: setValue, anchor, setAnchor, closeAll: () => setValue(false) }}
    >
      {children}
    </MenuContext.Provider>
  );
}

export function MenuTrigger({ asChild, onClick, disabled, ...props }: Props) {
  const menu = useMenu();
  const shared: Props = {
    ...props,
    disabled,
    "data-state": dataState(menu.open),
    "aria-expanded": menu.open,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (event.defaultPrevented || disabled) return;
      menu.setAnchor(boundsOf(event));
      menu.setOpen(!menu.open);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

/**
 * A dismiss layer with a hole: four occluding rects around `hole`, so the
 * bar under the hole (menubar, navigation menu) stays hoverable while open.
 */
export function DismissAround({ hole, onDismiss }: { hole: Bounds; onDismiss: () => void }) {
  const rects = [
    { top: 0, left: 0, right: 0, height: Math.max(0, hole.y) },
    { top: hole.y + hole.height, left: 0, right: 0, bottom: 0 },
    { top: hole.y, left: 0, width: Math.max(0, hole.x), height: hole.height },
    { top: hole.y, left: hole.x + hole.width, right: 0, height: hole.height },
  ];
  return (
    <>
      {rects.map((rect, index) => (
        <View
          key={index}
          occlude
          testID={index === 1 ? "menu-dismiss" : undefined}
          onPress={() => onDismiss()}
          style={{ position: "absolute", ...rect }}
        />
      ))}
    </>
  );
}

export function MenuPortal({ children }: Props) {
  return <>{children}</>;
}

export interface MenuContentProps extends Props {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
}

/** The menu panel, anchored to the menu's anchor rect. */
export function MenuContent({
  asChild,
  className,
  side = "bottom",
  align = "start",
  sideOffset = 0,
  alignOffset = 0,
  loop: _a,
  onCloseAutoFocus: _b,
  onEscapeKeyDown: _c,
  onPointerDownOutside: _d,
  onInteractOutside: _e,
  forceMount: _f,
  avoidCollisions: _g,
  collisionPadding: _h,
  nested = false,
  dismissAround,
  ...props
}: MenuContentProps & { nested?: boolean; dismissAround?: Bounds | null }) {
  const menu = useMenu();
  const [active, setActive] = useState<string | null>(null);
  if (!menu.open || !menu.anchor) return null;
  const shared: Props = {
    ...props,
    role: "menu",
    "data-state": "open",
    "data-side": side,
    className: stripPlacement(className),
  };
  return (
    <OverlayPortal>
      {nested ? null : dismissAround ? (
        <DismissAround hole={dismissAround} onDismiss={() => menu.setOpen(false)} />
      ) : (
        <DismissLayer testID="menu-dismiss" onDismiss={() => menu.setOpen(false)} />
      )}
      <Popper
        anchor={menu.anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
      >
        <SubSlotContext.Provider value={{ active, setActive }}>
          {asChild ? <Slot {...shared} /> : <div {...shared} />}
        </SubSlotContext.Provider>
      </Popper>
    </OverlayPortal>
  );
}

const CheckedContext = createContext<boolean | "indeterminate">(false);

export interface MenuItemProps extends Props {
  disabled?: boolean;
  onSelect?: (event: SyntheticEvent) => void;
  textValue?: string;
}

export function MenuItem({
  asChild,
  disabled,
  onSelect,
  onClick,
  textValue: _t,
  ...props
}: MenuItemProps) {
  const menu = useMenu();
  const subs = useContext(SubSlotContext);
  const shared: Props = {
    ...props,
    role: "menuitem",
    "data-disabled": disabled ? "" : undefined,
    "aria-disabled": disabled ? "true" : undefined,
    onMouseEnter: () => subs.setActive(null),
    onClick: (event: SyntheticEvent) => {
      if (disabled) return;
      (onClick as Handler)?.(event);
      onSelect?.(event);
      if (!event.defaultPrevented) menu.closeAll();
    },
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export function MenuCheckboxItem({
  checked = false,
  onCheckedChange,
  onSelect,
  ...props
}: MenuItemProps & {
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <CheckedContext.Provider value={checked}>
      <MenuItem
        {...props}
        role="menuitemcheckbox"
        aria-checked={checked === true}
        data-state={
          checked === "indeterminate" ? "indeterminate" : checked ? "checked" : "unchecked"
        }
        onSelect={(event) => {
          onCheckedChange?.(checked !== true);
          onSelect?.(event);
        }}
      />
    </CheckedContext.Provider>
  );
}

const RadioContext = createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

export function MenuRadioGroup({
  value,
  onValueChange,
  ...props
}: Props & { value?: string; onValueChange?: (value: string) => void }) {
  return (
    <RadioContext.Provider value={{ value, onValueChange }}>
      <div role="group" {...props} />
    </RadioContext.Provider>
  );
}

export function MenuRadioItem({ value, onSelect, ...props }: MenuItemProps & { value: string }) {
  const radio = useContext(RadioContext);
  const checked = radio.value === value;
  return (
    <CheckedContext.Provider value={checked}>
      <MenuItem
        {...props}
        role="menuitemradio"
        aria-checked={checked}
        data-state={checked ? "checked" : "unchecked"}
        onSelect={(event) => {
          radio.onValueChange?.(value);
          onSelect?.(event);
        }}
      />
    </CheckedContext.Provider>
  );
}

/** Renders its children only when the enclosing checkbox/radio item is checked. */
export function MenuItemIndicator({ asChild, forceMount: _f, ...props }: Props) {
  const checked = useContext(CheckedContext);
  if (!checked) return null;
  return asChild ? <Slot {...props} /> : <span {...props} />;
}

export function MenuLabel({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <div {...props} />;
}

export function MenuSeparator({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <div role="separator" {...props} />;
}

export function MenuGroup({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <div role="group" {...props} />;
}

const SubContext = createContext<MenuApi | null>(null);

/** A nested menu, opened by hovering or pressing its `SubTrigger`. */
export function MenuSub({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const parent = useMenu();
  const subs = useContext(SubSlotContext);
  const id = useStableId("sub");
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const [value, setValue] = useControllableState({
    prop: open,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });
  const isOpen = value && subs.active === id;
  const api: MenuApi = {
    open: isOpen,
    setOpen: (next) => {
      setValue(next);
      subs.setActive(next ? id : null);
    },
    anchor,
    setAnchor,
    closeAll: () => {
      setValue(false);
      parent.closeAll();
    },
  };
  return (
    <SubContext.Provider value={api}>
      <MenuContext.Provider value={api}>{children}</MenuContext.Provider>
    </SubContext.Provider>
  );
}

export function MenuSubTrigger({ asChild, disabled, ...props }: Props & { disabled?: boolean }) {
  const sub = useContext(SubContext);
  if (!sub) throw new Error("SubTrigger must be inside a Sub");
  const openAt = (event: SyntheticEvent) => {
    if (disabled) return;
    sub.setAnchor(boundsOf(event));
    sub.setOpen(true);
  };
  const shared: Props = {
    ...props,
    role: "menuitem",
    "data-state": dataState(sub.open),
    "data-disabled": disabled ? "" : undefined,
    onMouseEnter: openAt,
    onClick: openAt,
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export function MenuSubContent(props: MenuContentProps) {
  return <MenuContent side="right" align="start" sideOffset={2} {...props} nested />;
}

export const DropdownMenu = {
  Root: MenuRoot,
  Trigger: MenuTrigger,
  Portal: MenuPortal,
  Content: MenuContent,
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
