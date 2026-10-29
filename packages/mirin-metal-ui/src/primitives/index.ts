/**
 * Radix-compatible primitives for Metal. Upstream shadcn components import
 * `{ Dialog as DialogPrimitive } from "radix-ui"`; ported components import
 * the same names from here and keep their class strings verbatim.
 */

export { AlertDialog, Dialog } from "./dialog.tsx";
export { DropdownMenu } from "./menu.tsx";
export { Popover } from "./popover.tsx";
export { Slot } from "./slot.tsx";
