/**
 * Radix `Select` on Metal: a trigger showing the chosen item's text and a
 * listbox anchored under it. `Value` knows every item's text before the
 * content first opens (items are collected from the root's children, and
 * items rendered later register themselves).
 */

import type { Bounds } from "@mirinjs/metal";
import {
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import { DismissLayer, Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { useFormField } from "../runtime/form.tsx";
import { type Align, boundsOf, dataState, type Side, stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};
type Handler = ((event: SyntheticEvent) => void) | undefined;

interface SelectApi {
  value: string;
  setValue: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: Bounds | null;
  setAnchor: (bounds: Bounds | null) => void;
  disabled: boolean;
  /** Item value → its `ItemText` content. */
  labels: Map<string, ReactNode>;
  register: (value: string, label: ReactNode) => void;
}

const SelectContext = createContext<SelectApi | null>(null);

function useSelect(): SelectApi {
  const api = useContext(SelectContext);
  if (!api) throw new Error("Select parts must be inside <Select.Root>");
  return api;
}

/** `value` → children of every descendant element that looks like an item. */
function collectItems(children: ReactNode, out: Map<string, ReactNode>): Map<string, ReactNode> {
  const list = Array.isArray(children) ? children.flat(Number.POSITIVE_INFINITY) : [children];
  for (const child of list) {
    if (!isValidElement(child)) continue;
    const props = child.props as Props;
    if (typeof props.value === "string" && child.type !== Root) {
      out.set(props.value, findItemText(props.children) ?? props.children);
    } else {
      collectItems(props.children, out);
    }
  }
  return out;
}

export interface RootProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  dir?: string;
  children?: ReactNode;
  [prop: string]: unknown;
}

function Root({
  value,
  defaultValue = "",
  onValueChange,
  open,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  name,
  children,
}: RootProps) {
  const [current, setCurrent] = useControllableState({
    prop: value,
    defaultProp: defaultValue,
    onChange: onValueChange,
  });
  // metal: radix's hidden native select, so a named select submits with its form.
  useFormField(name, disabled ? undefined : current);
  const [isOpen, setOpen] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const [registered, setRegistered] = useState<Map<string, ReactNode>>(() => new Map());
  const labels = collectItems(children, new Map(registered));
  // Items rendered outside the static children (e.g. by a custom component)
  // register their text the first time they mount.
  const register = useCallback((item: string, label: ReactNode) => {
    setRegistered((previous) =>
      previous.has(item) ? previous : new Map(previous).set(item, label),
    );
  }, []);
  return (
    <SelectContext.Provider
      value={{
        value: current,
        setValue: setCurrent,
        open: isOpen,
        setOpen,
        anchor,
        setAnchor,
        disabled,
        labels,
        register,
      }}
    >
      {children}
    </SelectContext.Provider>
  );
}

function Trigger({ asChild, onClick, disabled: own, ...props }: Props & { disabled?: boolean }) {
  const select = useSelect();
  const disabled = select.disabled || own === true;
  const shared: Props = {
    ...props,
    type: "button",
    role: "combobox",
    "aria-expanded": select.open,
    "data-state": dataState(select.open),
    "data-placeholder": select.value === "" ? "" : undefined,
    "data-disabled": disabled ? "" : undefined,
    disabled,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (event.defaultPrevented || disabled) return;
      select.setAnchor(boundsOf(event));
      select.setOpen(!select.open);
    },
  };
  return asChild ? <Slot {...shared} /> : <button {...shared} />;
}

function Value({ asChild, placeholder, children, ...props }: Props & { placeholder?: ReactNode }) {
  const select = useSelect();
  const content =
    select.value === "" ? placeholder : (children ?? select.labels.get(select.value) ?? null);
  const shared: Props = { ...props, "data-placeholder": select.value === "" ? "" : undefined };
  return asChild ? (
    <Slot {...shared}>{content}</Slot>
  ) : (
    <span {...shared}>{content as ReactNode}</span>
  );
}

function Icon({ asChild, children, ...props }: Props) {
  const shared: Props = { ...props, "aria-hidden": true };
  return asChild ? <Slot {...shared}>{children}</Slot> : <span {...shared}>{children ?? "▼"}</span>;
}

function Portal({ children }: Props) {
  return <>{children}</>;
}

export interface ContentProps extends Props {
  position?: "item-aligned" | "popper";
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
}

function Content({
  asChild,
  className,
  position = "item-aligned",
  side = "bottom",
  align = "start",
  sideOffset = 4,
  alignOffset = 0,
  style,
  onCloseAutoFocus: _a,
  onEscapeKeyDown: _b,
  onPointerDownOutside: _c,
  avoidCollisions: _d,
  collisionPadding: _e,
  sticky: _f,
  hideWhenDetached: _g,
  updatePositionStrategy: _h,
  arrowPadding: _i,
  ...props
}: ContentProps) {
  const select = useSelect();
  if (!select.open || !select.anchor) return null;
  const shared: Props = {
    ...props,
    role: "listbox",
    "data-state": "open",
    "data-side": side,
    "data-align": align,
    className: stripPlacement(className),
    // metal: Radix caps the height at the available space; cap it here so
    // long lists scroll.
    style: { maxHeight: 384, ...(style as Record<string, unknown>) },
  };
  return (
    <OverlayPortal>
      <DismissLayer onDismiss={() => select.setOpen(false)} />
      {/* metal: item-aligned and popper both anchor under the trigger. */}
      <Popper
        anchor={select.anchor}
        side={side}
        align={position === "popper" ? align : "start"}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        matchWidth
      >
        {asChild ? <Slot {...shared} /> : <div {...shared} />}
      </Popper>
    </OverlayPortal>
  );
}

function Viewport({ asChild, className, ...props }: Props) {
  // metal: the trigger-size CSS variables have no meaning here.
  const shared: Props = { ...props, className, role: "presentation" };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

const ItemContext = createContext<{ selected: boolean }>({ selected: false });

function Item({
  asChild,
  value,
  disabled = false,
  textValue: _t,
  onClick,
  children,
  ...props
}: Props & { value: string; disabled?: boolean; textValue?: string }) {
  const select = useSelect();
  const selected = select.value === value;
  const { register } = select;
  useEffect(() => {
    register(value, findItemText(children) ?? children);
  }, [register, value, children]);
  const shared: Props = {
    ...props,
    role: "option",
    "aria-selected": selected,
    "data-state": selected ? "checked" : "unchecked",
    "data-disabled": disabled ? "" : undefined,
    "aria-disabled": disabled ? "true" : undefined,
    onClick: (event: SyntheticEvent) => {
      if (disabled) return;
      (onClick as Handler)?.(event);
      if (event.defaultPrevented) return;
      select.setValue(value);
      select.setOpen(false);
    },
  };
  return (
    <ItemContext.Provider value={{ selected }}>
      {asChild ? <Slot {...shared}>{children}</Slot> : <div {...shared}>{children}</div>}
    </ItemContext.Provider>
  );
}

/** The children of the first `ItemText` inside an item, if any. */
function findItemText(children: ReactNode): ReactNode | undefined {
  const list = Array.isArray(children) ? children.flat(Number.POSITIVE_INFINITY) : [children];
  for (const child of list) {
    if (!isValidElement(child)) continue;
    const props = child.props as Props;
    if (child.type === ItemText) return props.children;
    const inner = findItemText(props.children);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function ItemText({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <span {...props} />;
}

function ItemIndicator({ asChild, forceMount, ...props }: Props) {
  const { selected } = useContext(ItemContext);
  if (!selected && !forceMount) return null;
  return asChild ? <Slot {...props} /> : <span {...props} />;
}

function Group({ asChild, ...props }: Props) {
  const shared: Props = { ...props, role: "group" };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Label({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <div {...props} />;
}

function Separator({ asChild, ...props }: Props) {
  const shared: Props = { ...props, "aria-hidden": true };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

/** metal: content scrolls natively, so the hover-to-scroll buttons never show. */
function ScrollUpButton(_props: Props) {
  return null;
}

function ScrollDownButton(_props: Props) {
  return null;
}

function Arrow(_props: Props) {
  return null;
}

export const Select = {
  Root,
  Trigger,
  Value,
  Icon,
  Portal,
  Content,
  Viewport,
  Group,
  Label,
  Item,
  ItemText,
  ItemIndicator,
  Separator,
  ScrollUpButton,
  ScrollDownButton,
  Arrow,
};
