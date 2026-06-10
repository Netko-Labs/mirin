import { defineConfig } from "mirin/config";

export default defineConfig({
  id: "dev.peje.hello-react",
  name: "Hello React",

  // Main-process entry (runs in the Bun Worker). `mirin dev` bundles it.
  main: "main/main.ts",

  windows: {
    main: {
      title: "Hello mirin + React",
      width: 1100,
      height: 800,
      url: "app://ui/index.html", // dev: mirin loads the Vite dev server instead
      show: "ready",
    },
  },
});
