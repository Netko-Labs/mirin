/**
 * Radix `NavigationMenu` on Metal. The root holds which item is open; a
 * trigger opens its item's content on hover or press, anchored under the
 * trigger in the overlay layer. Hovering another trigger switches items
 * (the dismiss layer leaves a hole over the menu); pressing outside or
 * choosing a link closes it. With a `Viewport`, the content renders inside
 * the viewport's frame (its classes), as Radix renders it into the viewport.
 */

import type { Bounds } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState, useStableId } from "../lib/state.ts";
import { Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { DismissAround } from "./menu.tsx";
import { boundsOf, dataState, stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};
type Handler = ((event: SyntheticEvent) => void) | undefined;

interface NavApi {
  value: string;
  setValue: (value: string) => void;
  bounds: Bounds | null;
  anchor: Bounds | null;
  setAnchor: (anchor: Bounds | null) => void;
  /** Props of the mounted `Viewport`, if any: content renders inside its frame. */
  viewport: Props | null;
  setViewport: (props: Props | null) => void;
  orientation: string;
}

const NavContext = createContext<NavApi | null>(null);

function useNav(): NavApi {
  const api = useContext(NavContext);
  if (!api) throw new Error("NavigationMenu parts must be inside <NavigationMenu.Root>");
  return api;
}

const ItemContext = createContext("");

function Root({
  value,
  defaultValue = "",
  onValueChange,
  orientation = "horizontal",
  delayDuration: _a,
  skipDelayDuration: _b,
  dir: _c,
  children,
  ...props
}: Props & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
  delayDuration?: number;
  skipDelayDuration?: number;
  dir?: string;
}) {
  const [open, setOpen] = useControllableState({
    prop: value,
    defaultProp: defaultValue,
    onChange: onValueChange,
  });
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const [viewport, setViewport] = useState<Props | null>(null);
  const shared: Props = {
    "aria-label": "Main",
    "data-orientation": orientation,
    ...props,
    onLayout: setBounds,
  };
  return (
    <NavContext.Provider
      value={{
        value: open,
        setValue: setOpen,
        bounds,
        anchor,
        setAnchor,
        viewport,
        setViewport,
        orientation,
      }}
    >
      <nav {...shared}>{children}</nav>
    </NavContext.Provider>
  );
}

function List({ asChild, ...props }: Props) {
  const nav = useNav();
  const shared: Props = { ...props, "data-orientation": nav.orientation };
  return asChild ? <Slot {...shared} /> : <ul {...shared} />;
}

function Item({ value, asChild, ...props }: Props & { value?: string }) {
  const generated = useStableId("nav-item");
  return (
    <ItemContext.Provider value={value ?? generated}>
      {asChild ? <Slot {...props} /> : <li {...props} />}
    </ItemContext.Provider>
  );
}

function Trigger({
  asChild,
  disabled,
  onClick,
  onMouseEnter,
  ...props
}: Props & { disabled?: boolean }) {
  const nav = useNav();
  const item = useContext(ItemContext);
  const open = nav.value === item;
  const openAt = (event: SyntheticEvent) => {
    nav.setAnchor(boundsOf(event));
    nav.setValue(item);
  };
  const shared: Props = {
    ...props,
    disabled,
    "data-state": dataState(open),
    "data-disabled": disabled ? "" : undefined,
    "aria-expanded": open,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (event.defaultPrevented || disabled) return;
      if (open) nav.setValue("");
      else openAt(event);
    },
    onMouseEnter: (event: SyntheticEvent) => {
      (onMouseEnter as Handler)?.(event);
      if (!disabled && !open) openAt(event);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Content({
  asChild,
  className,
  forceMount: _a,
  onEscapeKeyDown: _b,
  onPointerDownOutside: _c,
  onFocusOutside: _d,
  onInteractOutside: _e,
  ...props
}: Props) {
  const nav = useNav();
  const item = useContext(ItemContext);
  if (nav.value !== item || !nav.anchor) return null;
  const shared: Props = {
    ...props,
    "data-state": "open",
    "data-orientation": nav.orientation,
    className: stripPlacement(className),
  };
  const body = asChild ? <Slot {...shared} /> : <div {...shared} />;
  const frame = nav.viewport;
  return (
    <OverlayPortal>
      {nav.bounds ? <DismissAround hole={nav.bounds} onDismiss={() => nav.setValue("")} /> : null}
      <Popper anchor={nav.anchor} side="bottom" align="start" sideOffset={0}>
        {frame ? (
          <div
            {...frame}
            data-state="open"
            data-orientation={nav.orientation}
            className={stripPlacement(frame.className as string | undefined)}
          >
            {body}
          </div>
        ) : (
          body
        )}
      </Popper>
    </OverlayPortal>
  );
}

/**
 * Registers its classes with the root; open content renders inside a frame
 * with them. The viewport itself paints nothing in place.
 */
function Viewport({ forceMount: _f, ...props }: Props) {
  const nav = useNav();
  const key = JSON.stringify(props, (_k, v) => (typeof v === "function" ? undefined : v));
  // biome-ignore lint/correctness/useExhaustiveDependencies: key summarizes props
  useLayoutEffect(() => {
    nav.setViewport(props);
    return () => nav.setViewport(null);
  }, [key]);
  return null;
}

function Link({
  asChild,
  active,
  onSelect,
  onClick,
  ...props
}: Props & { active?: boolean; onSelect?: (event: SyntheticEvent) => void }) {
  const nav = useNav();
  const shared: Props = {
    ...props,
    "data-active": active ? "true" : undefined,
    "aria-current": active ? "page" : undefined,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      onSelect?.(event);
      if (!event.defaultPrevented) nav.setValue("");
    },
  };
  return asChild ? <Slot {...shared} /> : <a {...shared} />;
}

/** metal: the indicator is a rotated square (CSS transform); omitted. */
function Indicator(_props: Props) {
  return null;
}

export const NavigationMenu = {
  Root,
  List,
  Item,
  Trigger,
  Content,
  Viewport,
  Link,
  Indicator,
};
