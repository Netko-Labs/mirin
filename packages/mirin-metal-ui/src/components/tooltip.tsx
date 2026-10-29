import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

interface TooltipApi {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const TooltipContext = createContext<TooltipApi>({ open: false, setOpen: () => {} });

export function TooltipProvider({ children }: { children?: ReactNode; delayDuration?: number }) {
  return <>{children}</>;
}

/** Shows on hover, anchored above the trigger (the trigger box is `relative`). */
export function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const current = open ?? internal;
  return (
    <TooltipContext.Provider
      value={{
        open: current,
        setOpen: (next) => {
          if (open === undefined) setInternal(next);
          onOpenChange?.(next);
        },
      }}
    >
      <Box className="flex flex-col relative">{children}</Box>
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
  asChild?: boolean;
}) {
  const api = useContext(TooltipContext);
  return (
    <Box className={className} onHoverChange={api.setOpen} testID={testID}>
      {children}
    </Box>
  );
}

export function TooltipContent({
  className,
  children,
  side = "top",
}: {
  className?: string;
  children?: ReactNode;
  side?: "top" | "bottom";
}) {
  const api = useContext(TooltipContext);
  if (!api.open) return null;
  return (
    <Box
      className={cn(
        "absolute rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground whitespace-nowrap",
        className,
      )}
      style={side === "top" ? { bottom: 36, left: 0 } : { top: 36, left: 0 }}
    >
      <Content>{children}</Content>
    </Box>
  );
}
