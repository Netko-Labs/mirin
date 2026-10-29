import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box } from "../lib/styled.tsx";

export interface PopoverApi {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const PopoverContext = createContext<PopoverApi>({ open: false, setOpen: () => {} });

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

/** Content opens anchored under the trigger (the Popover box is `relative`). */
export function Popover({ open, defaultOpen, onOpenChange, children }: PopoverProps) {
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const current = open ?? internal;
  return (
    <PopoverContext.Provider
      value={{
        open: current,
        setOpen: (next) => {
          if (open === undefined) setInternal(next);
          onOpenChange?.(next);
        },
      }}
    >
      <Box className="flex flex-col relative">{children}</Box>
    </PopoverContext.Provider>
  );
}

export function PopoverTrigger({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
  asChild?: boolean;
}) {
  const api = useContext(PopoverContext);
  return (
    <Box className={className} onPress={() => api.setOpen(!api.open)} testID={testID}>
      {children}
    </Box>
  );
}

export function PopoverContent({
  className,
  children,
  align = "start",
  sideOffset = 4,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  align?: "start" | "end";
  sideOffset?: number;
  testID?: string;
}) {
  const api = useContext(PopoverContext);
  if (!api.open) return null;
  return (
    <Box
      className={cn(
        "absolute w-72 rounded-md border bg-popover p-4 text-popover-foreground flex flex-col gap-2",
        className,
      )}
      style={{ top: 36 + sideOffset, ...(align === "end" ? { right: 0 } : { left: 0 }) }}
      testID={testID ?? "popover"}
    >
      {children}
    </Box>
  );
}

export function PopoverAnchor({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
