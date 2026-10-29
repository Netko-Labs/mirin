import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content, Txt } from "../lib/styled.tsx";

interface Section {
  className?: string;
  children?: ReactNode;
}

export function Breadcrumb({ className, children }: Section) {
  return <Box className={cn("flex flex-row", className)}>{children}</Box>;
}

export function BreadcrumbList({ className, children }: Section) {
  return (
    <Box
      className={cn(
        "flex flex-row flex-wrap items-center gap-1.5 text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </Box>
  );
}

export function BreadcrumbItem({ className, children }: Section) {
  return <Box className={cn("flex flex-row items-center gap-1.5", className)}>{children}</Box>;
}

export function BreadcrumbLink({
  className,
  children,
  onPress,
  testID,
}: Section & { onPress?: () => void; testID?: string }) {
  return (
    <Box className={cn("hover:text-foreground", className)} onPress={onPress} testID={testID}>
      <Content>{children}</Content>
    </Box>
  );
}

export function BreadcrumbPage({ className, children }: Section) {
  return (
    <Box className={cn("text-foreground font-normal", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function BreadcrumbSeparator({ children }: Section) {
  return <Txt className="text-muted-foreground">{children ?? "›"}</Txt>;
}

export function BreadcrumbEllipsis() {
  return <Txt className="text-muted-foreground">…</Txt>;
}
