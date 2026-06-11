import { app, globalShortcut } from "mirinjs";
import { router } from "./rpc.ts";

app.serve(router);

app.on("ready", () => {
  const panel = app.windows.get("panel");
  let shown = false;

  // Report whether the panel actually got Apple's Liquid Glass, or fell back to
  // a vibrancy material on older macOS.
  panel.on("material", (m) => {
    if (m.backend === "liquidGlass") {
      console.log("[spotlight] background: Apple Liquid Glass (NSGlassEffectView)");
    } else {
      console.log(
        `[spotlight] background: vibrancy fallback "${m.requested}" ` +
          `(Liquid Glass needs macOS 26+; available=${m.liquidGlassAvailable})`,
      );
    }
  });

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
