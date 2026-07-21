/**
 * End-to-end demo: normal React (hooks, state, flexbox styles) rendered as a
 * native GPU window via GPUI — no webview.
 *
 * 1. cd crates/mirin-native && cargo build --bin mirin-native-host
 * 2. cd packages/mirin-native && bun demo/counter.tsx
 */

import { useState } from "react";
import { render, spawnNativeHost, Text, View } from "../src/index.ts";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        backgroundColor: "#111114",
      }}
    >
      <Text style={{ fontSize: 28, color: "#f4f4f5" }}>count: {count}</Text>
      <View
        style={{ padding: 12, borderRadius: 8, backgroundColor: "#3b82f6" }}
        onPress={() => setCount((current) => current + 1)}
      >
        <Text style={{ color: "#ffffff" }}>tap me</Text>
      </View>
    </View>
  );
}

const binary =
  Bun.argv[2] ??
  new URL("../../../crates/mirin-native/target/debug/mirin-native-host", import.meta.url).pathname;
render(<Counter />, spawnNativeHost(binary));
