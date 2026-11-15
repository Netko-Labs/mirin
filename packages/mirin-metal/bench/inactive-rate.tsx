/**
 * The smallest program that shows it: a box moved by a patch every 16 ms for
 * two seconds, on a layer surface that takes no keyboard (as a Dock, a banner
 * or a menu bar is), and then in the same host on one that takes it.
 *
 *   MIRIN_METAL_TRACE=1 bun inactive-rate.tsx <host> [none|exclusive] 2>&1 | grep -c "render "
 *
 * With `none` the host draws about 42 frames for 125 patches (one every
 * 48 ms); with `exclusive`, once the compositor gives it the keyboard, 125.
 * Run it in a nested compositor: it opens a layer surface.
 */

import { render, spawnNativeHost, View } from "@mirinjs/metal";
import { useEffect, useState } from "react";

const [binary, keyboard = "none"] = process.argv.slice(2);
if (!binary || (keyboard !== "none" && keyboard !== "exclusive")) {
  console.error("usage: bun inactive-rate.tsx <host> [none|exclusive]");
  process.exit(2);
}

function Box() {
  const [x, setX] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setX((now) => (now + 4) % 400), 16);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={{ flex: 1, position: "relative" }}>
      <View
        style={{
          position: "absolute",
          left: x,
          top: 8,
          width: 48,
          height: 48,
          backgroundColor: "#6E56CF",
        }}
      />
    </View>
  );
}

const host = spawnNativeHost(binary, {
  title: "inactive-rate",
  width: 1,
  height: 64,
  surface: {
    layer: "top",
    anchor: ["bottom", "left", "right"],
    keyboard,
    namespace: "mirin.inactive-rate",
  },
});
render(<Box />, host);
setTimeout(() => {
  host.close();
  process.exit(0);
}, 2000);
