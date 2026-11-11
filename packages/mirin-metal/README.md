# @mirinjs/metal (alpha)

Write **normal React** — components, hooks, state, flexbox styles — and have it
rendered as **native GPU UI** via [GPUI](https://www.gpui.rs) (the Rust UI
framework from the creators of Zed). No webview: this is mirin's React
Native-like solution.

```tsx
import { useState } from "react";
import { render, spawnNativeHost, Text, View } from "@mirinjs/metal";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 28 }}>count: {count}</Text>
      <View style={{ padding: 12, borderRadius: 8, backgroundColor: "#3b82f6" }}
            onPress={() => setCount((c) => c + 1)}>
        <Text style={{ color: "#ffffff" }}>tap me</Text>
      </View>
    </View>
  );
}

render(<Counter />, spawnNativeHost(pathToMirinNativeHost));
```

## How it works

A custom React renderer (`react-reconciler`) hosts `<View>`/`<Text>`. Each
commit serializes the host tree to the JSON element format understood by
`crates/mirin-metal`, which renders it with GPU-drawn GPUI elements — layout
runs in GPUI's built-in flexbox engine, so the `style` props translate
directly. Interaction events (`onPress`) come back keyed by node id and invoke
your handlers; React re-renders; the next tree goes out.

```txt
normal React ──reconciler──▶ element tree JSON ──▶ mirin-metal (GPUI) ──▶ GPU pixels
     ▲                                                      │
     └──────────────── press events (node id) ──────────────┘
```

Transport today is stdio (`spawnNativeHost` spawns the `mirin-metal-host`
binary and speaks NDJSON). The in-process FFI transport replaces it when the
main-thread ownership question is settled (see the crate README).

## Try it

```sh
cd crates/mirin-metal && cargo build --bin mirin-metal-host
cd packages/mirin-metal && bun demo/counter.tsx
```

## Starting an app

`bun app.tsx` runs React's development build (Bun leaves `NODE_ENV` unset)
and JavaScriptCore's eight collector threads. An app people keep open starts
through the package's bin, which sets `NODE_ENV=production` and
`BUN_JSC_numberOfGCMarkers=1` and then becomes `bun app.tsx`:

```sh
bunx mirin-metal run app.tsx
```

A launcher that spawns apps itself passes `driverEnv()` as their environment.
See `docs/metal.md`, section 6.

## Status

Exploratory **alpha** (`0.1.0-alpha.x`). v1 surface: `<View>` (flexDirection,
gap, padding, width/height, `flex: 1` = fill, center alignment,
backgroundColor, borderRadius, onPress) and `<Text>` (color, fontSize, string
children). Not wired into the CEF runtime or published release tooling yet;
public-API changes go through `docs/api-design.md` sign-off before leaving
alpha.
