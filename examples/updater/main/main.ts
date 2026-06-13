import { app } from "mirinjs";
import { router } from "./rpc.ts";

const mirin = app.serve(router);

// Forward updater events to the UI as typed RPC events.
app.updater.on("status", (s) => mirin.rpc.updaterStatus.broadcast(s));
app.updater.on("progress", (p) => mirin.rpc.updaterProgress.broadcast(p));
app.updater.on("error", (e) => mirin.rpc.updaterError.broadcast(e));

app.on("ready", () => {
  console.log(
    `[updater-example] running ${app.updater.currentVersion} (${app.updater.channel}), ` +
      `updates ${app.updater.enabled ? "enabled" : "disabled (dev or no release config)"}`,
  );
});

app.on("window-all-closed", () => app.quit());
