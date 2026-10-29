import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";
import { buttonVariants } from "./button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  useDialog,
} from "./dialog.tsx";

export const AlertDialog = Dialog;
export const AlertDialogTrigger = DialogTrigger;
export const AlertDialogHeader = DialogHeader;
export const AlertDialogFooter = DialogFooter;
export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;

export function AlertDialogContent({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
}) {
  return (
    <DialogContent className={className} showCloseButton={false} testID={testID ?? "alert-dialog"}>
      {children}
    </DialogContent>
  );
}

export function AlertDialogAction({
  className,
  children,
  onClick,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  testID?: string;
}) {
  const api = useDialog();
  return (
    <Box
      className={cn(buttonVariants(), className)}
      onPress={() => {
        onClick?.();
        api.setOpen(false);
      }}
      testID={testID ?? "alert-dialog-action"}
    >
      <Content>{children}</Content>
    </Box>
  );
}

export function AlertDialogCancel({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const api = useDialog();
  return (
    <Box
      className={cn(buttonVariants({ variant: "outline" }), className)}
      onPress={() => api.setOpen(false)}
      testID={testID ?? "alert-dialog-cancel"}
    >
      <Content>{children}</Content>
    </Box>
  );
}
