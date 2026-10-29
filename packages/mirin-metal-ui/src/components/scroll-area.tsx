import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box } from "../lib/styled.tsx";

export interface ScrollAreaProps {
  className?: string;
  children?: ReactNode;
  orientation?: "vertical" | "horizontal" | "both";
  testID?: string;
}

export function ScrollArea({
  className,
  children,
  orientation = "vertical",
  testID,
}: ScrollAreaProps) {
  const overflow =
    orientation === "horizontal"
      ? "overflow-x-auto"
      : orientation === "both"
        ? ""
        : "overflow-auto";
  return (
    <Box
      className={cn("flex flex-col", overflow, className)}
      style={orientation === "both" ? { overflow: "scroll-both" } : undefined}
      testID={testID}
    >
      {children}
    </Box>
  );
}

/** Scrollbars are drawn by the renderer; kept for API parity. */
export function ScrollBar(_props: { orientation?: "vertical" | "horizontal" }) {
  return null;
}
