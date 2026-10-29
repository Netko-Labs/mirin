import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box } from "../lib/styled.tsx";

interface CollapsibleApi {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CollapsibleContext = createContext<CollapsibleApi>({ open: false, setOpen: () => {} });

export interface CollapsibleProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children?: ReactNode;
}

export function Collapsible({
  open,
  defaultOpen,
  onOpenChange,
  className,
  children,
}: CollapsibleProps) {
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const current = open ?? internal;
  return (
    <CollapsibleContext.Provider
      value={{
        open: current,
        setOpen: (next) => {
          if (open === undefined) setInternal(next);
          onOpenChange?.(next);
        },
      }}
    >
      <Box className={cn("flex flex-col", className)}>{children}</Box>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const api = useContext(CollapsibleContext);
  return (
    <Box className={className} onPress={() => api.setOpen(!api.open)} testID={testID}>
      {children}
    </Box>
  );
}

export function CollapsibleContent({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const api = useContext(CollapsibleContext);
  if (!api.open) return null;
  return <Box className={cn("flex flex-col", className)}>{children}</Box>;
}

export function useCollapsible(): CollapsibleApi {
  return useContext(CollapsibleContext);
}
