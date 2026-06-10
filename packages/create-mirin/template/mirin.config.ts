import { defineConfig } from "mirin/config";

export default defineConfig({
  id: "__APP_ID__",
  name: "__APP_NAME__",
  main: "main/main.ts",

  windows: {
    main: {
      title: "__APP_NAME__",
      width: 960,
      height: 700,
      url: "app://ui/index.html",
      show: "ready",
    },
  },
});
