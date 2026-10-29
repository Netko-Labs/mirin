/**
 * Off-screen screenshots of examples: runs a private virtual KWin session
 * (its own D-Bus, so Spectacle talks to it, not the desktop), opens the
 * example browser on each example, and saves `<out>/<example>.png`.
 *
 *   bun bench/shot.tsx [--out dir] [--host path] example [example…] > /dev/null
 *
 * (Redirect or ignore stdout: the session's D-Bus daemon keeps it open.)
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { render, spawnNativeHost } from "@mirinjs/metal";
import { Browser } from "../demo/browser.tsx";
import { ThemeProvider } from "../src/provider.tsx";

const args = Bun.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const out = resolve(option("--out") ?? "/tmp/metal-shots");
const host =
  option("--host") ??
  new URL("../../../crates/mirin-metal/target/release/mirin-metal-host", import.meta.url).pathname;
const inner = args[0] === "--inner";
if (inner) args.shift();
const examples = args;

if (!inner) {
  // Re-run this script inside a fresh virtual compositor session.
  mkdirSync(out, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.__EGL_VENDOR_LIBRARY_FILENAMES ??= "/usr/share/glvnd/egl_vendor.d/50_mesa.json";
  const command = [
    process.execPath,
    import.meta.path,
    "--inner",
    "--out",
    out,
    "--host",
    host,
    ...examples,
  ]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const session = Bun.spawn(
    [
      "dbus-run-session",
      "--",
      "kwin_wayland",
      "--virtual",
      "--socket",
      `metal-shot-${process.pid}`,
      "--width",
      "1600",
      "--height",
      "1000",
      "--exit-with-session",
      `sh -c "${command.replaceAll('"', '\\"')}"`,
    ],
    { env, stdout: "inherit", stderr: "ignore", cwd: join(import.meta.dir, "..") },
  );
  await session.exited;
  process.exit(0);
}

for (const example of examples) {
  // Unmounting a root closes its transport, so each example gets its own host.
  const transport = spawnNativeHost(host, { title: "metal-ui shot", width: 1440, height: 900 });
  const root = render(
    <ThemeProvider>
      <Browser initial={example} />
    </ThemeProvider>,
    transport,
  );
  await Bun.sleep(2500);
  const file = join(out, `${example}.png`);
  const capture = Bun.spawn(["spectacle", "-b", "-n", "-f", "-o", file], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => capture.kill("SIGKILL"), 10_000);
  await capture.exited;
  clearTimeout(timer);
  console.log(file);
  root.unmount();
  await Bun.sleep(300);
}
process.exit(0);
