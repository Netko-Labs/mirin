/**
 * Radix `Popover` on Metal: content anchors to the trigger's painted rect
 * (or a `Popover.Anchor`), flips to stay in the window, and closes when
 * the outside is pressed.
 */

import type { Bounds } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import { DismissLayer, Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { type Align, boundsOf, dataState, type Side, stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface PopoverApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: Bounds | null;
  setAnchor: (bounds: Bounds | null) => void;
  /** Set by `Popover.Anchor`; wins over the trigger rect. */
  pinned: boolean;
  setPinned: (pinned: boolean) => void;
}

const PopoverContext = createContext<PopoverApi | null>(null);

export function usePopoverContext(): PopoverApi {
  const api = useContext(PopoverContext);
  if (!api) throw new Error("Popover parts must be inside <Popover.Root>");
  return api;
}

function Root({
  open,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: ReactNode;
}) {
  const [value, setValue] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const [pinned, setPinned] = useState(false);
  return (
    <PopoverContext.Provider
      value={{ open: value, setOpen: setValue, anchor, setAnchor, pinned, setPinned }}
    >
      {children}
    </PopoverContext.Provider>
  );
}

function Trigger({ asChild, onClick, ...props }: Props) {
  const popover = usePopoverContext();
  const handle = (event: SyntheticEvent) => {
    (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
    if (event.defaultPrevented) return;
    if (!popover.pinned) popover.setAnchor(boundsOf(event));
    popover.setOpen(!popover.open);
  };
  const shared: Props = {
    ...props,
    "data-state": dataState(popover.open),
    "aria-expanded": popover.open,
    onClick: handle,
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

/** Anchor the content to this element instead of the trigger. */
function Anchor({ asChild, ...props }: Props) {
  const popover = usePopoverContext();
  const shared: Props = {
    ...props,
    onLayout: (bounds: Bounds) => {
      popover.setPinned(true);
      popover.setAnchor(bounds);
    },
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Portal({ children }: Props) {
  return <>{children}</>;
}

function Close({ asChild, onClick, ...props }: Props) {
  const popover = usePopoverContext();
  const shared: Props = {
    ...props,
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented) popover.setOpen(false);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

export interface ContentProps extends Props {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
}

function Content({
  asChild,
  className,
  side = "bottom",
  align = "center",
  sideOffset = 0,
  alignOffset = 0,
  onOpenAutoFocus: _a,
  onCloseAutoFocus: _b,
  onEscapeKeyDown: _c,
  onPointerDownOutside: _d,
  onInteractOutside: _e,
  forceMount: _f,
  avoidCollisions: _g,
  collisionPadding: _h,
  ...props
}: ContentProps) {
  const popover = usePopoverContext();
  if (!popover.open || !popover.anchor) return null;
  const shared: Props = {
    ...props,
    "data-state": "open",
    "data-side": side,
    "data-align": align,
    className: stripPlacement(className),
  };
  return (
    <OverlayPortal>
      <DismissLayer testID="popover-dismiss" onDismiss={() => popover.setOpen(false)} />
      <Popper
        anchor={popover.anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
      >
        {asChild ? <Slot {...shared} /> : <div {...shared} />}
      </Popper>
    </OverlayPortal>
  );
}

export const Popover = { Root, Trigger, Anchor, Portal, Content, Close };
