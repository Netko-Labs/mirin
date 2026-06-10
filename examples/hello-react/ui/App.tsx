import { useEffect, useState } from "react";
import { api } from "./api.ts";

export function App() {
  const [greeting, setGreeting] = useState("…");
  const [name, setName] = useState("world");
  const [ticks, setTicks] = useState(0);
  const [todos, setTodos] = useState<{ id: number; text: string }[]>([]);
  const [draft, setDraft] = useState("");

  // request/response
  useEffect(() => {
    api.greet(name).then(setGreeting);
  }, [name]);

  // main -> UI push events
  useEffect(() => api.tick.on(({ count }) => setTicks(count)), []);

  async function addTodo() {
    if (!draft.trim()) return;
    const todo = await api.addTodo(draft.trim());
    setTodos((t) => [...t, todo]);
    setDraft("");
  }

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2.5rem",
        maxWidth: 640,
        margin: "0 auto",
        color: "#1a1a2e",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>mirin + React</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Bun main process · CEF webview · typed RPC over a localhost socket
      </p>

      <section style={card}>
        <strong>Typed query</strong>
        <p style={{ fontSize: 18 }}>{greeting}</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="your name"
          style={input}
        />
      </section>

      <section style={card}>
        <strong>Push event from the Bun process</strong>
        <p style={{ fontSize: 32, margin: "8px 0 0" }}>tick #{ticks}</p>
      </section>

      <section style={card}>
        <strong>Typed mutation</strong>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTodo()}
            placeholder="add a todo"
            style={{ ...input, flex: 1 }}
          />
          <button onClick={addTodo} style={button}>
            Add
          </button>
        </div>
        <ul>
          {todos.map((t) => (
            <li key={t.id}>{t.text}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}

const card: React.CSSProperties = {
  background: "#f8f8fc",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "1rem 1.25rem",
  marginTop: 16,
};
const input: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #d1d5db",
  fontSize: 14,
};
const button: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: "#5b5bd6",
  color: "white",
  fontWeight: 600,
  cursor: "pointer",
};
