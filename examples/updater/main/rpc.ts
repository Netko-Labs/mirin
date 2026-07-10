import type { UpdateInfo, UpdateProgress, UpdaterStatus } from "mirinjs";
import { rpc } from "mirinjs/rpc";

/** RPC surface for the updater UI. Imported by the main process (handlers) and,
 *  as a type only, by the React UI (`mirinjs/client`). */
export const router = rpc.router({
  /** Current version/channel + whether updates are configured. */
  updaterInfo: rpc.query(async () => {
    const { app } = await import("mirinjs");
    return {
      version: app.updater.currentVersion,
      channel: app.updater.channel,
      enabled: app.updater.enabled,
      status: app.updater.status,
    };
  }),

  /** Poll the channel manifest; returns the available update or null. */
  checkForUpdate: rpc.mutation(async (): Promise<UpdateInfo | null> => {
    const { app } = await import("mirinjs");
    return app.updater.checkForUpdate();
  }),

  /** Download + verify the pending update (progress streams via `updaterProgress`). */
  downloadUpdate: rpc.mutation(async () => {
    const { app } = await import("mirinjs");
    await app.updater.download();
  }),

  /** Swap the .app and relaunch into the new version. */
  applyUpdate: rpc.mutation(async () => {
    const { app } = await import("mirinjs");
    await app.updater.applyAndRelaunch();
  }),

  // main -> UI pushes (re-broadcast from app.updater events in main.ts).
  updaterStatus: rpc.event<{ status: UpdaterStatus }>(),
  updaterProgress: rpc.event<UpdateProgress>(),
  updaterError: rpc.event<{ message: string }>(),
});

export type Router = typeof router;
