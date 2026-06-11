import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.liquid-glass",
  name: "Liquid Glass",
  main: "main/main.ts",

  windows: {
    // A floating window that starts with Apple's Liquid Glass material. The UI
    // swaps materials live via window.setMaterial (see main/rpc.ts). `material`
    // implies a transparent (windowless/OSR) window so the native glass shows.
    glass: {
      url: "app://ui/index.html",
      width: 760,
      height: 540,
      titleBarStyle: "hiddenInset",
      material: { type: "liquidGlass", cornerRadius: 20 },
      movableByBackground: true,
    },
  },
});
