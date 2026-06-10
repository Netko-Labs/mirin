import { app, globalShortcut } from "mirin";
import { router } from "./rpc.ts";

app.serve(router);

app.on("ready", () => {
  const panel = app.windows.get("panel");
  let shown = false;

  // Keep `shown` in sync with reality, and auto-hide when focus is lost.
  panel.on("focus", () => (shown = true));
  panel.on("blur", () => {
    shown = false;
    void panel.hide();
  });

  // Summon/dismiss from anywhere. (Avoids Cmd+Shift+Space, which 1Password and
  // others commonly claim.)
  globalShortcut.register("Cmd+Shift+J", () => {
    if (shown) {
      void panel.hide();
    } else {
      void panel.center();
      void panel.show();
    }
  });
});
