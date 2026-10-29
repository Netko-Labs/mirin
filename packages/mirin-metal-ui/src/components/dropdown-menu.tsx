import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content, Txt } from "../lib/styled.tsx";

interface MenuApi {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const MenuContext = createContext<MenuApi>({ open: false, setOpen: () => {} });

export interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

/** The menu opens anchored under its trigger (the menu box is `relative`). */
export function DropdownMenu({ open, defaultOpen, onOpenChange, children }: DropdownMenuProps) {
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const current = open ?? internal;
  return (
    <MenuContext.Provider
      value={{
        open: current,
        setOpen: (next) => {
          if (open === undefined) setInternal(next);
          onOpenChange?.(next);
        },
      }}
    >
      <Box className="flex flex-col relative">{children}</Box>
    </MenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  className,
  children,
  testID,
  disabled = false,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
  disabled?: boolean;
  asChild?: boolean;
}) {
  const api = useContext(MenuContext);
  return (
    <Box
      className={className}
      onPress={() => {
        if (!disabled) api.setOpen(!api.open);
      }}
      testID={testID}
    >
      {children}
    </Box>
  );
}

export function DropdownMenuContent({
  className,
  children,
  align = "start",
  testID,
}: {
  className?: string;
  children?: ReactNode;
  align?: "start" | "end";
  sideOffset?: number;
  testID?: string;
}) {
  const api = useContext(MenuContext);
  if (!api.open) return null;
  return (
    <Box
      className={cn(
        "absolute min-w-32 rounded-md border bg-popover p-1 text-popover-foreground flex flex-col",
        className,
      )}
      style={{ top: 36, ...(align === "end" ? { right: 0 } : { left: 0 }) }}
      testID={testID ?? "dropdown-menu"}
    >
      {children}
    </Box>
  );
}

export interface DropdownMenuItemProps {
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  onSelect?: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
  inset?: boolean;
  testID?: string;
}

export function DropdownMenuItem({
  className,
  children,
  onClick,
  onSelect,
  disabled = false,
  variant = "default",
  inset = false,
  testID,
}: DropdownMenuItemProps) {
  const api = useContext(MenuContext);
  return (
    <Box
      className={cn(
        "flex flex-row items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
        variant === "destructive" && "text-destructive",
        inset && "pl-8",
        disabled && "opacity-50",
        className,
      )}
      onPress={() => {
        if (disabled) return;
        onClick?.();
        onSelect?.();
        api.setOpen(false);
      }}
      testID={testID}
    >
      <Content>{children}</Content>
    </Box>
  );
}

export function DropdownMenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
  className,
  testID,
}: {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  children?: ReactNode;
  className?: string;
  testID?: string;
}) {
  return (
    <DropdownMenuItem
      className={className}
      onSelect={() => onCheckedChange?.(!checked)}
      testID={testID}
    >
      <Txt className="w-4">{checked ? "✓" : ""}</Txt>
      <Content>{children}</Content>
    </DropdownMenuItem>
  );
}

export function DropdownMenuLabel({
  className,
  children,
  inset = false,
}: {
  className?: string;
  children?: ReactNode;
  inset?: boolean;
}) {
  return (
    <Box className={cn("px-2 py-1.5 text-sm font-medium", inset && "pl-8", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <Box className={cn("h-px bg-border my-1", className)} />;
}

export function DropdownMenuShortcut({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Box className={cn("ml-auto text-xs text-muted-foreground", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function DropdownMenuGroup({ children }: { children?: ReactNode }) {
  return <Box className="flex flex-col">{children}</Box>;
}

/** Context menus share the dropdown implementation; they open on press. */
export const ContextMenu = DropdownMenu;
export const ContextMenuTrigger = DropdownMenuTrigger;
export const ContextMenuContent = DropdownMenuContent;
export const ContextMenuItem = DropdownMenuItem;
export const ContextMenuSeparator = DropdownMenuSeparator;
export const ContextMenuLabel = DropdownMenuLabel;
export const ContextMenuShortcut = DropdownMenuShortcut;
