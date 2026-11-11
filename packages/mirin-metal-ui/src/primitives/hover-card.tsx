/**
 * Radix `HoverCard` on Metal: hovering the trigger opens the card after
 * `openDelay` (700ms); leaving the trigger closes it after `closeDelay`
 * (300ms) unless the pointer moves onto the card, which keeps it open.
 */

import { createContext, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { boundsOf, stripPlacement } from "./shared.tsx";
import { type FloatingContentProps, useHoverOpen } from "./tooltip.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};
type Handler = ((event: SyntheticEvent) => void) | undefined;

const HoverCardContext = createContext<ReturnType<typeof useHoverOpen> | null>(null);

function useHoverCard(): ReturnType<typeof useHoverOpen> {
  const api = useContext(HoverCardContext);
  if (!api) throw new Error("HoverCard parts must be inside <HoverCard.Root>");
  return api;
}

function Root({
  open,
  defaultOpen,
  onOpenChange,
  openDelay = 700,
  closeDelay = 300,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openDelay?: number;
  closeDelay?: number;
  children?: ReactNode;
}) {
  const hover = useHoverOpen({ open, defaultOpen, onOpenChange, openDelay, closeDelay });
  return <HoverCardContext.Provider value={hover}>{children}</HoverCardContext.Provider>;
}

function Trigger({ asChild, onMouseEnter, onMouseLeave, ...props }: Props) {
  const card = useHoverCard();
  const shared: Props = {
    ...props,
    "data-state": card.open ? "open" : "closed",
    onMouseEnter: (event: SyntheticEvent) => {
      (onMouseEnter as Handler)?.(event);
      card.show(boundsOf(event));
    },
    onMouseLeave: (event: SyntheticEvent) => {
      (onMouseLeave as Handler)?.(event);
      card.hide();
    },
  };
  return asChild ? <Slot {...shared} /> : <a {...shared} />;
}

function Portal({ children }: Props) {
  return <>{children}</>;
}

function Content({
  asChild,
  className,
  side = "bottom",
  align = "center",
  sideOffset = 0,
  alignOffset = 0,
  onMouseEnter,
  onMouseLeave,
  forceMount: _a,
  avoidCollisions: _b,
  collisionPadding: _c,
  hideWhenDetached: _d,
  sticky: _e,
  ...props
}: FloatingContentProps) {
  const card = useHoverCard();
  if (!card.open || !card.anchor) return null;
  const shared: Props = {
    ...props,
    "data-state": "open",
    "data-side": side,
    "data-align": align,
    className: stripPlacement(className),
    onMouseEnter: (event: SyntheticEvent) => {
      (onMouseEnter as Handler)?.(event);
      card.show(null);
    },
    onMouseLeave: (event: SyntheticEvent) => {
      (onMouseLeave as Handler)?.(event);
      card.hide();
    },
  };
  return (
    <OverlayPortal>
      <Popper
        anchor={card.anchor}
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

/** metal: the arrow needs a CSS transform; omitted. */
function Arrow(_props: Props) {
  return null;
}

export const HoverCard = { Root, Trigger, Portal, Content, Arrow };
