import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export interface LabelProps {
  className?: string;
  children?: ReactNode;
  /** Accepted for API parity; Metal has no form association. */
  htmlFor?: string;
}

export function Label({ className, children }: LabelProps) {
  return (
    <Box className={cn("flex flex-row items-center gap-2 text-sm font-medium", className)}>
      <Content>{children}</Content>
    </Box>
  );
}
