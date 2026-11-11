import { Slot as SlotComponent } from "../lib/slot.tsx";

/** `Slot.Root` (radix-ui namespace style) and `Slot` (callable) both work. */
export const Slot = Object.assign(SlotComponent, { Root: SlotComponent, Slot: SlotComponent });
