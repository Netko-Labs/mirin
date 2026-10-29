import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export function Kbd({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Box
      className={cn(
        "flex flex-row items-center justify-center rounded-sm border bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground font-mono",
        className,
      )}
    >
      <Content>{children}</Content>
    </Box>
  );
}

export function KbdGroup({ className, children }: { className?: string; children?: ReactNode }) {
  return <Box className={cn("flex flex-row items-center gap-1", className)}>{children}</Box>;
}
