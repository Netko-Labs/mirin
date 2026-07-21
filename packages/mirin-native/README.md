# @mirinjs/native (alpha)

Write **normal React** — components, hooks, state, flexbox styles — and have it
rendered as **native GPU UI** via [GPUI](https://www.gpui.rs) (the Rust UI
framework from the creators of Zed). No webview: this is mirin's React
Native-like solution.

```tsx
import { useState } from "react";
import { render, spawnNativeHost, Text, View } from "@mirinjs/native";

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
`crates/mirin-native`, which renders it with GPU-drawn GPUI elements — layout
runs in GPUI's built-in flexbox engine, so the `style` props translate
directly. Interaction events (`onPress`) come back keyed by node id and invoke
your handlers; React re-renders; the next tree goes out.

```txt
normal React ──reconciler──▶ element tree JSON ──▶ mirin-native (GPUI) ──▶ GPU pixels
     ▲                                                      │
     └──────────────── press events (node id) ──────────────┘
```

Transport today is stdio (`spawnNativeHost` spawns the `mirin-native-host`
binary and speaks NDJSON). The in-process FFI transport replaces it when the
main-thread ownership question is settled (see the crate README).

## Try it

```sh
cd crates/mirin-native && cargo build --bin mirin-native-host
cd packages/mirin-native && bun demo/counter.tsx
```

## Status

Exploratory **alpha** (`0.1.0-alpha.x`). v1 surface: `<View>` (flexDirection,
gap, padding, width/height, `flex: 1` = fill, center alignment,
backgroundColor, borderRadius, onPress) and `<Text>` (color, fontSize, string
children). Not wired into the CEF runtime or published release tooling yet;
public-API changes go through `docs/api-design.md` sign-off before leaving
alpha.
