import { useEffect, useState } from "react";
import { api } from "./api.ts";

export function App() {
  const [greeting, setGreeting] = useState("…");
  const [name, setName] = useState("world");
  const [ticks, setTicks] = useState(0);

  useEffect(() => {
    api.greet(name).then(setGreeting);
  }, [name]);

  useEffect(() => api.tick.on(({ count }) => setTicks(count)), []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "3rem",
        maxWidth: 560,
        margin: "0 auto",
        color: "#1a1a2e",
      }}
    >
      <h1>__APP_NAME__</h1>
      <p style={{ color: "#6b7280" }}>
        Bun main process · CEF webview · typed RPC over a localhost socket.
      </p>

      <p style={{ fontSize: 18 }}>{greeting}</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="your name"
        style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db" }}
      />

      <p style={{ fontSize: 28, marginTop: 24 }}>tick #{ticks}</p>
    </main>
  );
}
