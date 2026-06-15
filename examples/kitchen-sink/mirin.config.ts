import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.kitchen-sink",
  name: "Kitchen Sink",
  main: "main/main.ts",

  // Bundle the compiled sidecar binary (built by `bun run build:sidecar` into
  // vendor/tool — see package.json) into Contents/Resources/sidecars/ and spawn
  // it with app.sidecar("tool"). It's codesigned with the app; no entitlements
  // needed here. See sidecar/tool.ts + main/tools.ts.
  sidecars: {
    tool: "vendor/tool",
  },

  windows: {
    main: {
      title: "mirin · Kitchen Sink",
      width: 980,
      height: 760,
      url: "app://ui/index.html",
      titleBarStyle: "hiddenInset", // custom title bar demo (draggable header in the UI)
      show: "ready",
    },
  },
});
