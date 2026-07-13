/**
 * Menu-bar tray items. A tray with a `menu` shows it on click (items route
 * through the shared menu registry); a tray without a menu fires `onClick`.
 */

import { buildNativeMenu, type MenuItemTemplate, releaseMenuHandlers } from "./menu.ts";
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
  #menuIds: number[] = [];

  constructor(options: TrayOptions) {
    if (options.onClick) clickHandlers.set(this.id, options.onClick);
    let menu: ReturnType<typeof buildNativeMenu>["native"] | undefined;
    if (options.menu) {
      const built = buildNativeMenu(options.menu);
      menu = built.native;
      this.#menuIds = built.ids;
    }
    runtime().core.trayCreate(
      JSON.stringify({
        id: this.id,
        title: options.title,
        tooltip: options.tooltip,
        menu,
      }),
    );
  }

  destroy(): void {
    runtime().core.trayDestroy(this.id);
    clickHandlers.delete(this.id);
    releaseMenuHandlers(this.#menuIds);
    this.#menuIds = [];
  }
}
