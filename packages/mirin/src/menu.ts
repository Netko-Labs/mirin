/**
 * Native menus. A template item's `click` handler is kept in a registry keyed
 * by an auto-assigned id; the native side reports clicks as `menu.click` events
 * carrying that id. `role` items map to AppKit's standard actions.
 */

import { runtime, onNativeEvent } from "./runtime.ts";

export type MenuRole =
  | "quit" | "close" | "minimize" | "zoom" | "front" | "togglefullscreen"
  | "hide" | "hideothers" | "unhide"
  | "undo" | "redo" | "cut" | "copy" | "paste" | "selectall" | "delete";

export interface MenuItemTemplate {
  label?: string;
  role?: MenuRole;
  type?: "normal" | "separator" | "submenu";
  /** e.g. "Cmd+N", "Cmd+Shift+P". */
  accelerator?: string;
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
  submenu?: MenuItemTemplate[];
}

interface NativeMenuItem {
  id?: number;
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  enabled?: boolean;
  checked?: boolean;
  submenu?: NativeMenuItem[];
}

let nextId = 1;
const clickHandlers = new Map<number, () => void>();

onNativeEvent("menu.click", (event) => {
  clickHandlers.get(event.id as number)?.();
});

/** Convert a template to the native JSON shape, registering click handlers. */
export function buildNativeMenu(items: MenuItemTemplate[]): NativeMenuItem[] {
  return items.map((item) => {
    const native: NativeMenuItem = {
      label: item.label,
      role: item.role,
      type: item.type,
      accelerator: item.accelerator,
      enabled: item.enabled,
      checked: item.checked,
    };
    if (item.click) {
      const id = nextId++;
      clickHandlers.set(id, item.click);
      native.id = id;
    }
    if (item.submenu) native.submenu = buildNativeMenu(item.submenu);
    return native;
  });
}

export const menu = {
  /** Replace the application menu bar. */
  setApplicationMenu(template: MenuItemTemplate[]): void {
    runtime().core.setAppMenu(JSON.stringify(buildNativeMenu(template)));
  },
  /** Show a context menu at the cursor. */
  popup(template: MenuItemTemplate[]): void {
    runtime().core.popupMenu(JSON.stringify(buildNativeMenu(template)));
  },
};
