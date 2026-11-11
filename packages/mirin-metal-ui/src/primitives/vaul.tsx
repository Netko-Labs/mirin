/**
 * Stand-in for the `vaul` package on Metal: `Drawer.Root/Trigger/Portal/
 * Overlay/Content/Close/Title/Description/Handle`. The drawer is a sheet
 * pinned to a window edge (`direction`, bottom by default); the content
 * carries `data-vaul-drawer-direction` so shadcn's direction variants place
 * it. Pressing the overlay closes it when `dismissible`. Drag-to-dismiss,
 * snap points, and background scaling are not implemented.
 */

import { createContext, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import { Portal as OverlayPortal } from "../overlay/host.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { dataState } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};
type Handler = ((event: SyntheticEvent) => void) | undefined;
export type DrawerDirection = "top" | "bottom" | "left" | "right";

interface DrawerApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  direction: DrawerDirection;
  dismissible: boolean;
}

const DrawerContext = createContext<DrawerApi | null>(null);

function useDrawer(): DrawerApi {
  const api = useContext(DrawerContext);
  if (!api) throw new Error("Drawer parts must be inside <Drawer.Root>");
  return api;
}

export interface DrawerRootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  direction?: DrawerDirection;
  dismissible?: boolean;
  modal?: boolean;
  shouldScaleBackground?: boolean;
  snapPoints?: Array<number | string>;
  children?: ReactNode;
  [prop: string]: unknown;
}

function Root({
  open,
  defaultOpen = false,
  onOpenChange,
  onClose,
  direction = "bottom",
  dismissible = true,
  children,
}: DrawerRootProps) {
  const [value, setValue] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: (next: boolean) => {
      onOpenChange?.(next);
      if (!next) onClose?.();
    },
  });
  return (
    <DrawerContext.Provider value={{ open: value, setOpen: setValue, direction, dismissible }}>
      {children}
    </DrawerContext.Provider>
  );
}

function Trigger({ asChild, onClick, ...props }: Props) {
  const drawer = useDrawer();
  const shared: Props = {
    ...props,
    "data-state": dataState(drawer.open),
    "aria-expanded": drawer.open,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (!event.defaultPrevented) drawer.setOpen(!drawer.open);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Close({ asChild, onClick, ...props }: Props) {
  const drawer = useDrawer();
  const shared: Props = {
    ...props,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (!event.defaultPrevented) drawer.setOpen(false);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Portal({ children }: Props) {
  const drawer = useDrawer();
  if (!drawer.open) return null;
  return <OverlayPortal>{children}</OverlayPortal>;
}

function Overlay({ asChild, ...props }: Props) {
  const drawer = useDrawer();
  if (!drawer.open) return null;
  const shared: Props = {
    ...props,
    "vaul-overlay": "",
    "data-state": "open",
    occlude: true,
    onClick: () => {
      if (drawer.dismissible) drawer.setOpen(false);
    },
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Content({
  asChild,
  onOpenAutoFocus: _a,
  onCloseAutoFocus: _b,
  onEscapeKeyDown: _c,
  onPointerDownOutside: _d,
  onInteractOutside: _e,
  forceMount: _f,
  ...props
}: Props) {
  const drawer = useDrawer();
  if (!drawer.open) return null;
  const shared: Props = {
    ...props,
    role: "dialog",
    "vaul-drawer": "",
    "data-state": "open",
    "data-vaul-drawer-direction": drawer.direction,
    occlude: true,
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Title({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <h2 {...props} />;
}

function Description({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <p {...props} />;
}

function Handle({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <div vaul-handle="" {...props} />;
}

export const Drawer = {
  Root,
  NestedRoot: Root,
  Trigger,
  Portal,
  Overlay,
  Content,
  Close,
  Title,
  Description,
  Handle,
};
