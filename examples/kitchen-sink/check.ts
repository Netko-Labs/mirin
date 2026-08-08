/**
 * A `mirin check` scenario for the app-shell features. Tray/hotkey/deep links are
 * invisible in the DOM, so it reads the slice `main.ts` publishes with `devtools.expose`.
 */

import { defineCheck } from "mirinjs/check";

interface Shell {
  tray: boolean;
  hotkey: string;
  deepLinks: string[];
  windows: { id: number; name: string }[];
}

export default defineCheck(async (app) => {
  app.step("the app shell reports itself");
  const shell = (await app.exposed()).shell as Shell | undefined;
  app.assert(shell !== undefined, "main.ts never exposed a `shell` slice");
  app.assert(shell.tray, "the menu-bar tray was not installed");
  app.assert(shell.hotkey.length > 0, "no global hotkey was registered");

  app.step("a second window opens and is addressable");
  await app.click("text=Open window");
  await app.waitUntil(
    async () => (await app.windows()).length === 2,
    "the second window never opened",
  );

  const windows = await app.windows();
  // Even a runtime-opened window gets a name; otherwise a tool could only address it by id.
  app.assert(
    windows.every((window) => window.name.length > 0),
    `every window should be addressable by name: ${JSON.stringify(windows)}`,
  );
  await app.screenshot("two-windows");
});
