/**
 * Radix-compatible primitives for Metal. Upstream shadcn components import
 * `{ Dialog as DialogPrimitive } from "radix-ui"`; ported components import
 * the same names from here and keep their class strings verbatim.
 *
 * Stand-ins for other third-party libraries (cmdk, vaul, sonner, embla,
 * input-otp, react-resizable-panels, Base UI) live beside these files and are
 * reached through the components that use them.
 */

export { Accordion } from "./accordion.tsx";
export { AspectRatio } from "./aspect-ratio.tsx";
export { Avatar } from "./avatar.tsx";
export { Checkbox } from "./checkbox.tsx";
export { Collapsible } from "./collapsible.tsx";
export { ContextMenu } from "./context-menu.tsx";
export { AlertDialog, Dialog } from "./dialog.tsx";
export { Direction } from "./direction.tsx";
export { HoverCard } from "./hover-card.tsx";
export { Label } from "./label.tsx";
export { DropdownMenu } from "./menu.tsx";
export { Menubar } from "./menubar.tsx";
export { NavigationMenu } from "./navigation-menu.tsx";
export { Popover } from "./popover.tsx";
export { Progress } from "./progress.tsx";
export { RadioGroup } from "./radio-group.tsx";
export { ScrollArea } from "./scroll-area.tsx";
export { Select } from "./select.tsx";
export { Separator } from "./separator.tsx";
export { Slider } from "./slider.tsx";
export { Slot } from "./slot.tsx";
export { Switch } from "./switch.tsx";
export { Tabs } from "./tabs.tsx";
export { Toggle } from "./toggle.tsx";
export { ToggleGroup } from "./toggle-group.tsx";
export { Tooltip } from "./tooltip.tsx";
