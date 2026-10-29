import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Portal, Scrim } from "../lib/overlay.tsx";
import { Box, Content } from "../lib/styled.tsx";
import { useTheme, withAlpha } from "../theme.ts";

export interface DialogApi {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const DialogContext = createContext<DialogApi>({ open: false, setOpen: () => {} });

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

export function Dialog({ open, defaultOpen, onOpenChange, children }: DialogProps) {
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const current = open ?? internal;
  return (
    <DialogContext.Provider
      value={{
        open: current,
        setOpen: (next) => {
          if (open === undefined) setInternal(next);
          onOpenChange?.(next);
        },
      }}
    >
      {children}
    </DialogContext.Provider>
  );
}

export function DialogTrigger({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
  asChild?: boolean;
}) {
  const api = useContext(DialogContext);
  return (
    <Box className={className} onPress={() => api.setOpen(true)} testID={testID}>
      {children}
    </Box>
  );
}

export function DialogClose({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
  asChild?: boolean;
}) {
  const api = useContext(DialogContext);
  return (
    <Box className={className} onPress={() => api.setOpen(false)} testID={testID}>
      {children}
    </Box>
  );
}

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  showCloseButton?: boolean;
  testID?: string;
}) {
  const api = useContext(DialogContext);
  const theme = useTheme();
  if (!api.open) return null;
  return (
    <Portal>
      <DialogContext.Provider value={api}>
        <Scrim
          onPress={() => api.setOpen(false)}
          color={withAlpha("#000000", 0.5)}
          testID="dialog-overlay"
        />
        <Box className="flex flex-1 items-center justify-center">
          <Box
            className={cn(
              "flex flex-col gap-4 rounded-lg border bg-background p-6 text-foreground w-[448px] max-w-[512px] relative",
              className,
            )}
            testID={testID ?? "dialog"}
          >
            {children}
            {showCloseButton ? (
              <Box
                className="absolute rounded-sm opacity-70 hover:opacity-100 px-1"
                style={{ top: 12, right: 12 }}
                onPress={() => api.setOpen(false)}
                testID="dialog-close"
              >
                <Content className="text-foreground">✕</Content>
              </Box>
            ) : null}
          </Box>
        </Box>
      </DialogContext.Provider>
    </Portal>
  );
}

export function DialogHeader({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return <Box className={cn("flex flex-col gap-2", className)}>{children}</Box>;
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return <Box className={cn("flex flex-row justify-end gap-2", className)}>{children}</Box>;
}

export function DialogTitle({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Box className={cn("text-lg font-semibold", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function DialogDescription({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Box className={cn("text-sm text-muted-foreground", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function useDialog(): DialogApi {
  return useContext(DialogContext);
}
