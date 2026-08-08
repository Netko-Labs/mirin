import { app, devtools } from "mirinjs";
import { router } from "./rpc.ts";

const mirin = app.serve(router);

let count = 0;

// Publish main-process state to the devtools inspector's `/state`. A tool driving
// this app can read the page's DOM, but nothing here — the tick counter lives in
// the Bun process. The getter runs per read, so this is always current.
// See docs/agent-devtools.md; delete it if you don't want the visibility.
devtools.expose("app", () => ({ ticks: count, windows: app.windows.all().length }));

app.on("ready", () => {
  // Push a typed tick to every webview once a second.
  setInterval(() => {
    mirin.rpc.tick.broadcast({ count: ++count });
  }, 1000);
});

app.on("window-all-closed", () => {
  app.quit();
});
