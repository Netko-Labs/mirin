/**
 * Menu-bar tray items. A tray with a `menu` shows it on click (items route
 * through the shared menu registry); a tray without a menu fires `onClick`.
 */

import { buildNativeMenu, type MenuItemTemplate } from "./menu.ts";
import { onNativeEvent, runtime } from "./runtime.ts";

export interface TrayOptions {
  title?: string;
  tooltip?: string;
  menu?: MenuItemTemplate[];
  onClick?: () => void;
}

let nextId = 1;
const clickHandlers = new Map<number, () => void>();

onNativeEvent("tray.click", (event) => {
  clickHandlers.get(event.id as number)?.();
});

export class Tray {
  readonly id = nextId++;

  constructor(options: TrayOptions) {
    if (options.onClick) clickHandlers.set(this.id, options.onClick);
    runtime().core.trayCreate(
      JSON.stringify({
        id: this.id,
        title: options.title,
        tooltip: options.tooltip,
        menu: options.menu ? buildNativeMenu(options.menu) : undefined,
      }),
    );
  }

  destroy(): void {
    runtime().core.trayDestroy(this.id);
    clickHandlers.delete(this.id);
  }
}
