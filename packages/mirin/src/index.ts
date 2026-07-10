/**
 * mirin — the main-process API (runs in the Bun Worker).
 *
 * Importing this module boots the runtime (loads libmirin_core, starts the RPC
 * server, begins draining native events) and exposes the developer-facing API:
 * the `app` singleton plus the `menu`, `Tray`, `dialog`, `clipboard`,
 * `globalShortcut`, and `logger` features (docs/api-design.md).
 */

import { app, wireAppEvents } from "./app/index.ts";
import { boot } from "./runtime.ts";

// Side-effect imports: each feature subscribes its native-event handlers.
import "./menu.ts";
import "./tray.ts";
import "./dialog.ts";
import "./shortcut.ts";

export type {
  AppEvents,
  BroadcastEmitters,
  Dock,
  ServeHandle,
  WindowEvents,
  WindowFrame,
  WindowHandle,
  WindowMaterialInfo,
  WindowOpenOptions,
} from "./app/index.ts";
export { app } from "./app/index.ts";
export { clipboard } from "./clipboard.ts";
export type {
  CefConfig,
  DmgConfig,
  InnoConfig,
  LinuxConfig,
  LinuxPackageFormat,
  MirinConfig,
  NsisConfig,
  ReleaseConfig,
  SidecarEntitlement,
  SidecarSpec,
  WindowConfig,
  WindowMaterial,
  WindowMaterialOptions,
} from "./config/index.ts";
export type { MessageDialogOptions, OpenDialogOptions, SaveDialogOptions } from "./dialog.ts";
export { dialog } from "./dialog.ts";
export type { LogLevel } from "./logger.ts";
export { getLogLevel, Logger, logger, setLogLevel } from "./logger.ts";
export type { MenuItemTemplate, MenuRole } from "./menu.ts";
export { menu } from "./menu.ts";
export { NotAttachedError, resolveWorker } from "./runtime.ts";
export { globalShortcut } from "./shortcut.ts";
export type { SidecarOptions, SidecarProcess } from "./sidecar.ts";
export { sidecar } from "./sidecar.ts";
export type { TrayOptions } from "./tray.ts";
export { Tray } from "./tray.ts";
export type { UpdateInfo, UpdateProgress, UpdaterEvents, UpdaterStatus } from "./updater/index.ts";
export { Updater, updater } from "./updater/index.ts";

wireAppEvents();
boot();

// Re-export so `import mirin from "mirin"` style also works if desired.
export default app;
