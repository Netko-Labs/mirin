/**
 * Global (system-wide) keyboard shortcuts. Each registration gets an id; the
 * native side reports presses as `shortcut.trigger` events.
 */

import { runtime, onNativeEvent } from "./runtime.ts";

let nextId = 1;
const handlers = new Map<number, () => void>();
const idByAccelerator = new Map<string, number>();

onNativeEvent("shortcut.trigger", (event) => {
  handlers.get(event.id as number)?.();
});

export const globalShortcut = {
  /** Register a global hotkey, e.g. "Cmd+Shift+K". Returns false if invalid. */
  register(accelerator: string, handler: () => void): boolean {
    this.unregister(accelerator);
    const id = nextId++;
    handlers.set(id, handler);
    const ok = runtime().core.shortcutRegister(id, accelerator);
    if (ok) {
      idByAccelerator.set(accelerator, id);
    } else {
      handlers.delete(id);
    }
    return ok;
  },

  unregister(accelerator: string): void {
    const id = idByAccelerator.get(accelerator);
    if (id == null) return;
    runtime().core.shortcutUnregister(id);
    handlers.delete(id);
    idByAccelerator.delete(accelerator);
  },

  unregisterAll(): void {
    for (const accelerator of [...idByAccelerator.keys()]) this.unregister(accelerator);
  },
};
