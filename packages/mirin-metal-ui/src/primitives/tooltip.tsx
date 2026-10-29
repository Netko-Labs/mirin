/**
 * Radix `Tooltip` on Metal: hovering the trigger opens the content after
 * `delayDuration` (0 under shadcn's provider), anchored to the trigger's
 * rect on `side` (top by default); leaving the trigger closes it. The
 * content floats in the overlay layer without a dismiss layer.
 */

import type { Bounds } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import { Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { type Align, boundsOf, type Side, stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};
type Handler = ((event: SyntheticEvent) => void) | undefined;

const ProviderContext = createContext<{ delayDuration: number }>({ delayDuration: 0 });

function Provider({
  delayDuration = 700,
  children,
}: {
  delayDuration?: number;
  skipDelayDuration?: number;
  disableHoverableContent?: boolean;
  children?: ReactNode;
}) {
  return <ProviderContext.Provider value={{ delayDuration }}>{children}</ProviderContext.Provider>;
}

interface TooltipApi {
  open: boolean;
  anchor: Bounds | null;
  show: (anchor: Bounds | null) => void;
  hide: () => void;
}

const TooltipContext = createContext<TooltipApi | null>(null);

function useTooltip(): TooltipApi {
  const api = useContext(TooltipContext);
  if (!api) throw new Error("Tooltip parts must be inside <Tooltip.Root>");
  return api;
}

/** Open/close with an open delay; shared by Tooltip and HoverCard. */
export function useHoverOpen({
  open,
  defaultOpen = false,
  onOpenChange,
  openDelay,
  closeDelay,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openDelay: number;
  closeDelay: number;
}): {
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: Bounds | null;
  show: (anchor: Bounds | null) => void;
  hide: () => void;
} {
  const [value, setValue] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const later = (delay: number, run: () => void) => {
    clear();
    if (delay <= 0) run();
    else timer.current = setTimeout(run, delay);
  };
  return {
    open: value,
    setOpen: setValue,
    anchor,
    show: (next) => {
      if (next) setAnchor(next);
      later(openDelay, () => setValue(true));
    },
    hide: () => later(closeDelay, () => setValue(false)),
  };
}

function Root({
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  disableHoverableContent?: boolean;
  children?: ReactNode;
}) {
  const provider = useContext(ProviderContext);
  const hover = useHoverOpen({
    open,
    defaultOpen,
    onOpenChange,
    openDelay: delayDuration ?? provider.delayDuration,
    closeDelay: 0,
  });
  return (
    <TooltipContext.Provider
      value={{ open: hover.open, anchor: hover.anchor, show: hover.show, hide: hover.hide }}
    >
      {children}
    </TooltipContext.Provider>
  );
}

function Trigger({ asChild, onMouseEnter, onMouseLeave, onClick, ...props }: Props) {
  const tooltip = useTooltip();
  const shared: Props = {
    ...props,
    "data-state": tooltip.open ? "delayed-open" : "closed",
    onMouseEnter: (event: SyntheticEvent) => {
      (onMouseEnter as Handler)?.(event);
      tooltip.show(boundsOf(event));
    },
    onMouseLeave: (event: SyntheticEvent) => {
      (onMouseLeave as Handler)?.(event);
      tooltip.hide();
    },
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      tooltip.hide();
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Portal({ children }: Props) {
  return <>{children}</>;
}

export interface FloatingContentProps extends Props {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
}

function Content({
  asChild,
  className,
  side = "top",
  align = "center",
  sideOffset = 0,
  alignOffset = 0,
  onEscapeKeyDown: _a,
  onPointerDownOutside: _b,
  forceMount: _c,
  avoidCollisions: _d,
  collisionPadding: _e,
  hideWhenDetached: _f,
  sticky: _g,
  "aria-label": _h,
  ...props
}: FloatingContentProps) {
  const tooltip = useTooltip();
  if (!tooltip.open || !tooltip.anchor) return null;
  const shared: Props = {
    ...props,
    role: "tooltip",
    "data-state": "delayed-open",
    "data-side": side,
    "data-align": align,
    className: stripPlacement(className),
  };
  return (
    <OverlayPortal>
      <Popper
        anchor={tooltip.anchor}
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

/** metal: the arrow is a rotated square (CSS transform); Metal has no transforms, so it is omitted. */
function Arrow(_props: Props) {
  return null;
}

export const Tooltip = { Provider, Root, Trigger, Portal, Content, Arrow };
