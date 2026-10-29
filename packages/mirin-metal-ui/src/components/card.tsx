import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

interface SectionProps {
  className?: string;
  children?: ReactNode;
  testID?: string;
}

export function Card({ className, children, testID }: SectionProps) {
  return (
    <Box
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground",
        className,
      )}
      testID={testID}
    >
      {children}
    </Box>
  );
}

export function CardHeader({ className, children }: SectionProps) {
  return <Box className={cn("flex flex-col gap-1.5 px-6", className)}>{children}</Box>;
}

export function CardTitle({ className, children }: SectionProps) {
  return (
    <Box className={cn("font-semibold text-base", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function CardDescription({ className, children }: SectionProps) {
  return (
    <Box className={cn("text-sm text-muted-foreground", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function CardAction({ className, children }: SectionProps) {
  return <Box className={cn("flex flex-row justify-end", className)}>{children}</Box>;
}

export function CardContent({ className, children }: SectionProps) {
  return <Box className={cn("flex flex-col gap-4 px-6", className)}>{children}</Box>;
}

export function CardFooter({ className, children }: SectionProps) {
  return <Box className={cn("flex flex-row items-center gap-2 px-6", className)}>{children}</Box>;
}
