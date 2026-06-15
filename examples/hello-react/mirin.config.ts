import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.hello-react",
  name: "Hello React",

  // Main-process entry (runs in the Bun Worker). `mirin dev` bundles it.
  main: "main/main.ts",

  // Extra Bun Workers bundled next to the main worker; resolve with
  // `resolveWorker("hash")` and pass to `new Worker(...)`. CPU/IO offload only —
  // no window/native APIs (see main/hash.worker.ts + main/offload.ts).
  workers: {
    hash: "main/hash.worker.ts",
  },

  // Bundle external binaries into the .app and spawn them with `app.sidecar(name)`.
  // Each is copied into Contents/Resources/sidecars/, codesigned (hardened
  // runtime), and notarized with the app. Prefer a PATH/installed binary unless
  // you need a pinned version offline. Example (uncomment + provide the binary):
  //
  // sidecars: {
  //   ripgrep: "vendor/rg",
  //   // or, for a binary that needs entitlements under the hardened runtime:
  //   engine: { bin: "vendor/engine", entitlements: ["disable-library-validation"] },
  // },

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
