import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.spotlight",
  name: "Spotlight",
  main: "main/main.ts",

  windows: {
    // A borderless, translucent, floating panel created hidden — summoned by a
    // global hotkey (see main/main.ts).
    panel: {
      url: "app://ui/index.html",
      width: 680,
      height: 420,
      titleBarStyle: "hidden",
      transparent: true,
      alwaysOnTop: true,
      movableByBackground: true,
      visible: false,
    },
  },
});
