/**
 * Radix `ContextMenu` on Metal: the trigger opens the menu on right-click,
 * anchored to the pointer as a zero-size rect. Everything inside the menu is
 * the shared menu machinery (`menu.tsx`).
 */

import type { ReactNode } from "react";
import { Slot } from "../lib/slot.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import {
  MenuCheckboxItem,
  MenuContent,
  type MenuContentProps,
  MenuGroup,
  MenuItem,
  MenuItemIndicator,
  MenuLabel,
  MenuPortal,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  useMenu,
} from "./menu.tsx";
import { dataState } from "./shared.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

function Root({
  onOpenChange,
  children,
}: {
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  dir?: string;
  children?: ReactNode;
}) {
  return <MenuRoot onOpenChange={onOpenChange}>{children}</MenuRoot>;
}

function Trigger({ asChild, disabled, onContextMenu, ...props }: Props & { disabled?: boolean }) {
  const menu = useMenu();
  const shared: Props = {
    ...props,
    "data-state": dataState(menu.open),
    "data-disabled": disabled ? "" : undefined,
    onContextMenu: (event: SyntheticEvent) => {
      (onContextMenu as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (event.defaultPrevented || disabled) return;
      menu.setAnchor({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
      menu.setOpen(true);
    },
  };
  return asChild ? <Slot {...shared} /> : <span {...shared} />;
}

/** Opens to the right of and below the pointer, like a native context menu. */
function Content(props: MenuContentProps) {
  return <MenuContent side="right" align="start" sideOffset={2} {...props} />;
}

export const ContextMenu = {
  Root,
  Trigger,
  Portal: MenuPortal,
  Content,
  Group: MenuGroup,
  Label: MenuLabel,
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  ItemIndicator: MenuItemIndicator,
  Separator: MenuSeparator,
  Sub: MenuSub,
  SubTrigger: MenuSubTrigger,
  SubContent: MenuSubContent,
};
