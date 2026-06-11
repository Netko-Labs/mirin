import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.spotlight",
  name: "Spotlight",
  main: "main/main.ts",

  windows: {
    // A borderless, Liquid Glass floating panel created hidden — summoned by a
    // global hotkey (see main/main.ts). `material` renders Apple's Liquid Glass
    // (NSGlassEffectView) behind the web UI and implies a transparent window.
    panel: {
      url: "app://ui/index.html",
      width: 680,
      height: 420,
      titleBarStyle: "hidden",
      material: { type: "liquidGlass", cornerRadius: 18 },
      alwaysOnTop: true,
      movableByBackground: true,
      visible: false,
    },
  },
});
