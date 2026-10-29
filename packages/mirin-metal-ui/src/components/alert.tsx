import type { ReactNode } from "react";
import { cn, cva, type VariantProps } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export const alertVariants = cva("flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground",
      destructive: "bg-card text-destructive border-destructive/50",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface AlertProps extends VariantProps<typeof alertVariants> {
  className?: string;
  children?: ReactNode;
}

export function Alert({ className, variant, children }: AlertProps) {
  return <Box className={cn(alertVariants({ variant }), className)}>{children}</Box>;
}

export function AlertTitle({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Box className={cn("font-medium", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function AlertDescription({
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
