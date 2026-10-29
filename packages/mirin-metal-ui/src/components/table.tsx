import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

interface Section {
  className?: string;
  children?: ReactNode;
}

/**
 * Tables are flex rows of fixed-width cells: Metal has no table layout, so
 * `TableHead`/`TableCell` take a `width` (default 160px). Pass the same widths
 * in the header and body rows to keep columns aligned.
 */
export function Table({ className, children }: Section) {
  return (
    <Box className={cn("flex flex-col text-sm", className)} style={{ overflow: "scroll-both" }}>
      {children}
    </Box>
  );
}

export function TableHeader({ className, children }: Section) {
  return <Box className={cn("flex flex-col", className)}>{children}</Box>;
}

export function TableBody({ className, children }: Section) {
  return <Box className={cn("flex flex-col", className)}>{children}</Box>;
}

export function TableFooter({ className, children }: Section) {
  return <Box className={cn("flex flex-col bg-muted/50 font-medium", className)}>{children}</Box>;
}

export interface TableRowProps extends Section {
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
}

export function TableRow({ className, children, onPress, selected, testID }: TableRowProps) {
  return (
    <Box
      className={cn(
        "flex flex-row items-center border-b hover:bg-muted/50",
        selected && "bg-muted",
        className,
      )}
      onPress={onPress}
      testID={testID}
    >
      {children}
    </Box>
  );
}

interface CellProps extends Section {
  width?: number;
}

export function TableHead({ className, children, width = 160 }: CellProps) {
  return (
    <Box
      className={cn("h-10 flex flex-row items-center px-2 text-foreground font-medium", className)}
      style={{ width, flexShrink: 0 }}
    >
      <Content className="truncate">{children}</Content>
    </Box>
  );
}

export function TableCell({ className, children, width = 160 }: CellProps) {
  return (
    <Box
      className={cn("flex flex-row items-center p-2", className)}
      style={{ width, flexShrink: 0 }}
    >
      <Content className="truncate">{children}</Content>
    </Box>
  );
}

export function TableCaption({ className, children }: Section) {
  return (
    <Box className={cn("text-muted-foreground text-sm py-2", className)}>
      <Content>{children}</Content>
    </Box>
  );
}
