import type { ReactNode } from "react";
import { useContext } from "react";
import { cn } from "../lib/cn.ts";
import { Portal, Scrim } from "../lib/overlay.tsx";
import { Box, Content } from "../lib/styled.tsx";
import { withAlpha } from "../theme.ts";
import {
  Dialog,
  DialogContext,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";

export const Sheet = Dialog;
export const SheetTrigger = DialogTrigger;
export const SheetHeader = DialogHeader;
export const SheetFooter = DialogFooter;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;

export function SheetContent({
  className,
  children,
  side = "right",
  testID,
}: {
  className?: string;
  children?: ReactNode;
  side?: "left" | "right" | "top" | "bottom";
  testID?: string;
}) {
  const api = useContext(DialogContext);
  if (!api.open) return null;
  const placement =
    side === "right"
      ? { top: 0, bottom: 0, right: 0, width: 384 }
      : side === "left"
        ? { top: 0, bottom: 0, left: 0, width: 384 }
        : side === "top"
          ? { top: 0, left: 0, right: 0 }
          : { bottom: 0, left: 0, right: 0 };
  return (
    <Portal>
      <DialogContext.Provider value={api}>
        <Scrim
          onPress={() => api.setOpen(false)}
          color={withAlpha("#000000", 0.5)}
          testID="sheet-overlay"
        />
        <Box
          className={cn(
            "absolute flex flex-col gap-4 border bg-background p-6 text-foreground",
            className,
          )}
          style={{ position: "absolute", ...placement }}
          testID={testID ?? "sheet"}
        >
          {children}
          <Box
            className="absolute rounded-sm opacity-70 hover:opacity-100 px-1"
            style={{ top: 12, right: 12 }}
            onPress={() => api.setOpen(false)}
            testID="sheet-close"
          >
            <Content className="text-foreground">✕</Content>
          </Box>
        </Box>
      </DialogContext.Provider>
    </Portal>
  );
}

export function SheetClose({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const api = useContext(DialogContext);
  return (
    <Box className={className} onPress={() => api.setOpen(false)} testID={testID}>
      {children}
    </Box>
  );
}
