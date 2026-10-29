import type { ReactNode } from "react";
import { cn, cva, type VariantProps } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export const toggleVariants = cva(
  "flex flex-row items-center justify-center gap-2 rounded-md text-sm font-medium hover:bg-muted",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent",
      },
      size: {
        default: "h-9 px-2 min-w-9",
        sm: "h-8 px-1.5 min-w-8",
        lg: "h-10 px-2.5 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ToggleProps extends VariantProps<typeof toggleVariants> {
  pressed: boolean;
  onPressedChange?: (pressed: boolean) => void;
  className?: string;
  children?: ReactNode;
  testID?: string;
}

export function Toggle({
  pressed,
  onPressedChange,
  variant,
  size,
  className,
  children,
  testID,
}: ToggleProps) {
  return (
    <Box
      className={cn(
        toggleVariants({ variant, size }),
        pressed && "bg-accent text-accent-foreground",
        className,
      )}
      onPress={() => onPressedChange?.(!pressed)}
      testID={testID}
    >
      <Content>{children}</Content>
    </Box>
  );
}
