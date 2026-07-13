/**
 * Native menus. A template item's `click` handler is kept in a registry keyed
 * by an auto-assigned id; the native side reports clicks as `menu.click` events
 * carrying that id. `role` items map to AppKit's standard actions.
 */

import { onNativeEvent, runtime } from "./runtime.ts";

export type MenuRole =
  | "quit"
  | "close"
  | "minimize"
  | "zoom"
  | "front"
  | "togglefullscreen"
  | "hide"
  | "hideothers"
  | "unhide"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectall"
  | "delete";

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

/** A built menu: the native JSON shape plus the handler ids it registered, so
 *  the owner can release them when the menu is replaced or dismissed. */
export interface BuiltMenu {
  native: NativeMenuItem[];
  ids: number[];
}

/** Convert a template to the native JSON shape, registering click handlers into
 *  a fresh id set. The caller owns `ids` and must pass them to
 *  `releaseMenuHandlers` once the menu is gone, or the closures leak. */
export function buildNativeMenu(items: MenuItemTemplate[]): BuiltMenu {
  const ids: number[] = [];
  const build = (list: MenuItemTemplate[]): NativeMenuItem[] =>
    list.map((item) => {
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
        ids.push(id);
        native.id = id;
      }
      if (item.submenu) native.submenu = build(item.submenu);
      return native;
    });
  return { native: build(items), ids };
}

/** Drop click handlers previously registered by `buildNativeMenu`. */
export function releaseMenuHandlers(ids: number[]): void {
  for (const id of ids) clickHandlers.delete(id);
}

// Handlers for the currently-installed app menu and the most recent popup, kept
// so each replacement frees the previous generation instead of leaking it.
let appMenuIds: number[] = [];
let popupIds: number[] = [];

export const menu = {
  /** Replace the application menu bar. */
  setApplicationMenu(template: MenuItemTemplate[]): void {
    const built = buildNativeMenu(template);
    runtime().core.setAppMenu(JSON.stringify(built.native));
    releaseMenuHandlers(appMenuIds);
    appMenuIds = built.ids;
  },
  /** Show a context menu at the cursor. */
  popup(template: MenuItemTemplate[]): void {
    const built = buildNativeMenu(template);
    runtime().core.popupMenu(JSON.stringify(built.native));
    // Free the prior popup's handlers; at most one popup's worth is retained.
    releaseMenuHandlers(popupIds);
    popupIds = built.ids;
  },
};
