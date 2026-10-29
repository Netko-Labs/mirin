import type { ReactNode } from "react";
import { cn, cva, type VariantProps } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export const badgeVariants = cva(
  "flex flex-row items-center justify-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-white",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  className?: string;
  children?: ReactNode;
  onPress?: () => void;
  testID?: string;
}

export function Badge({ className, variant, children, onPress, testID }: BadgeProps) {
  return (
    <Box className={cn(badgeVariants({ variant }), className)} onPress={onPress} testID={testID}>
      <Content>{children}</Content>
    </Box>
  );
}
