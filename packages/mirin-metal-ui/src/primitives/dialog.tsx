/**
 * Radix `Dialog` and `AlertDialog` on Metal: same part names and props.
 * Content renders centered in the overlay layer above a scrim; pressing the
 * scrim closes a Dialog (not an AlertDialog).
 */

import { View } from "@mirinjs/metal";
import { createContext, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import { Portal as OverlayPortal } from "../overlay/host.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { dataState, stripPlacement } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface DialogApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** AlertDialogs ignore outside presses. */
  dismissable: boolean;
}

const DialogContext = createContext<DialogApi>({
  open: false,
  setOpen: () => {},
  dismissable: true,
});

export function useDialogContext(): DialogApi {
  return useContext(DialogContext);
}

export interface RootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: ReactNode;
}

function makeRoot(dismissable: boolean) {
  return function Root({ open, defaultOpen = false, onOpenChange, children }: RootProps) {
    const [value, setValue] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    return (
      <DialogContext.Provider value={{ open: value, setOpen: setValue, dismissable }}>
        {children}
      </DialogContext.Provider>
    );
  };
}

function Trigger({ asChild, onClick, ...props }: Props) {
  const dialog = useDialogContext();
  const handle = (event: SyntheticEvent) => {
    (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
    if (!event.defaultPrevented) dialog.setOpen(!dialog.open);
  };
  const shared: Props = { ...props, "data-state": dataState(dialog.open), onClick: handle };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Close({ asChild, onClick, ...props }: Props) {
  const dialog = useDialogContext();
  const handle = (event: SyntheticEvent) => {
    (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
    if (!event.defaultPrevented) dialog.setOpen(false);
  };
  const shared: Props = { ...props, onClick: handle };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

/** Renders into the overlay layer while the dialog is open. */
function Portal({ children }: Props) {
  const dialog = useDialogContext();
  if (!dialog.open) return null;
  return <OverlayPortal>{children}</OverlayPortal>;
}

function Overlay({ asChild, ...props }: Props) {
  const dialog = useDialogContext();
  if (!dialog.open) return null;
  const shared: Props = {
    ...props,
    "data-state": dataState(dialog.open),
    occlude: true,
    onClick: () => {
      if (dialog.dismissable) dialog.setOpen(false);
    },
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Content({
  asChild,
  className,
  children,
  onOpenAutoFocus: _a,
  onCloseAutoFocus: _b,
  onEscapeKeyDown: _c,
  onPointerDownOutside: _d,
  onInteractOutside: _e,
  forceMount: _f,
  ...props
}: Props) {
  const dialog = useDialogContext();
  if (!dialog.open) return null;
  const shared: Props = {
    ...props,
    role: dialog.dismissable ? "dialog" : "alertdialog",
    "data-state": "open",
    occlude: true,
    className: stripPlacement(className),
  };
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      {asChild ? <Slot {...shared}>{children}</Slot> : <div {...shared}>{children}</div>}
    </View>
  );
}

function Title({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <h2 {...props} />;
}

function Description({ asChild, ...props }: Props) {
  return asChild ? <Slot {...props} /> : <p {...props} />;
}

export const Dialog = {
  Root: makeRoot(true),
  Trigger,
  Portal,
  Overlay,
  Content,
  Close,
  Title,
  Description,
};

export const AlertDialog = {
  Root: makeRoot(false),
  Trigger,
  Portal,
  Overlay,
  Content,
  Title,
  Description,
  Action: Close,
  Cancel: Close,
};
