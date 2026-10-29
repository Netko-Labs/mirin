/**
 * Radix-compatible primitives for Metal. Upstream shadcn components import
 * `{ Dialog as DialogPrimitive } from "radix-ui"`; ported components import
 * the same names from here and keep their class strings verbatim.
 */

import { Slot as SlotComponent } from "../lib/slot.tsx";

export { AlertDialog, Dialog } from "./dialog.tsx";
export { DropdownMenu } from "./menu.tsx";
export { Popover } from "./popover.tsx";

/** `Slot.Root` (radix-ui namespace style) and `Slot` (callable) both work. */
export const Slot = Object.assign(SlotComponent, { Root: SlotComponent, Slot: SlotComponent });
