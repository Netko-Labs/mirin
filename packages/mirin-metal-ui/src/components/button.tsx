import type { ReactNode } from "react";
import { cn, cva, type VariantProps } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export const buttonVariants = cva(
  "flex flex-row items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md gap-1.5 px-3",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  /** React Native alias for `onClick`. */
  onPress?: () => void;
  children?: ReactNode;
  testID?: string;
}

export function Button({
  className,
  variant,
  size,
  disabled = false,
  onClick,
  onPress,
  children,
  testID,
}: ButtonProps) {
  const handler = onClick ?? onPress;
  return (
    <Box
      className={cn(buttonVariants({ variant, size }), disabled && "opacity-50", className)}
      onPress={() => {
        if (!disabled) handler?.();
      }}
      testID={testID}
    >
      <Content>{children}</Content>
    </Box>
  );
}
