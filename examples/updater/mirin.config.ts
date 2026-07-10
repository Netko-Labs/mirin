import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.updater-example",
  name: "Updater Example",
  main: "main/main.ts",

  // Auto-update config. `mirin release` emits artifacts named for this channel;
  // the built app polls `${baseUrl}/${channel}-${platform}-${arch}-update.json`.
  //
  //   Self-host (local test): `bun serve.ts` serves ./build/release on :4000.
  //   GitHub Releases:     baseUrl: "https://github.com/<org>/<repo>/releases/latest/download"
  release: {
    baseUrl: "http://localhost:4000",
    channel: "stable",
  },

  windows: {
    main: {
      title: "mirin updater",
      width: 720,
      height: 560,
      url: "app://ui/index.html",
      show: "ready",
    },
  },
});
