import { app } from "mirinjs";
import { router } from "./rpc.ts";

const mirin = app.serve(router);

app.on("ready", () => {
  console.log("[hello-react] all windows ready");

  // Push a typed tick to every webview once a second.
  let count = 0;
  setInterval(() => {
    mirin.rpc.tick.broadcast({ count: ++count });
  }, 1000);
});

app.on("window-all-closed", () => {
  app.quit();
});
