/**
 * mirin — the main-process API (runs in the Bun Worker).
 *
 * Importing this module boots the runtime (loads libmirin_core, starts the RPC
 * server, begins draining native events) and exposes the developer-facing API:
 * the `app` singleton plus the `menu`, `Tray`, `dialog`, `clipboard`, and
 * `globalShortcut` features (docs/api-design.md).
 */

import { app, wireAppEvents } from "./app.ts";
import { boot } from "./runtime.ts";

// Side-effect imports: each feature subscribes its native-event handlers.
import "./menu.ts";
import "./tray.ts";
import "./dialog.ts";
import "./shortcut.ts";

export { app } from "./app.ts";
export { menu } from "./menu.ts";
export { Tray } from "./tray.ts";
export { dialog } from "./dialog.ts";
export { clipboard } from "./clipboard.ts";
export { globalShortcut } from "./shortcut.ts";
export { NotAttachedError } from "./runtime.ts";

export type {
  WindowEvents,
  WindowMaterialInfo,
  AppEvents,
  WindowHandle,
  WindowOpenOptions,
  ServeHandle,
  BroadcastEmitters,
  Dock,
} from "./app.ts";
export type { MenuItemTemplate, MenuRole } from "./menu.ts";
export type { TrayOptions } from "./tray.ts";
export type { OpenDialogOptions, SaveDialogOptions, MessageDialogOptions } from "./dialog.ts";
export type {
  MirinConfig,
  WindowConfig,
  WindowMaterial,
  WindowMaterialOptions,
} from "./config.ts";

wireAppEvents();
boot();

// Re-export so `import mirin from "mirin"` style also works if desired.
export default app;
