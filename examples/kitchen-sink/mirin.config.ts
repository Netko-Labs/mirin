import { defineConfig } from "mirin/config";

export default defineConfig({
  id: "dev.peje.kitchen-sink",
  name: "Kitchen Sink",
  main: "main/main.ts",

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
