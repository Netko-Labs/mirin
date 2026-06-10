import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-query whenever the text changes; keep focus on the input.
  useEffect(() => {
    let alive = true;
    api.search(query).then((r) => {
      if (!alive) return;
      setResults(r);
      setActive(0);
    });
    return () => {
      alive = false;
    };
  }, [query]);

  // Focus the field when the panel (re)appears.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      api.hide(null);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      api.run(results[active]);
    }
  }

  return (
    <div className="panel" onKeyDown={onKeyDown}>
      <div className="search">
        <span className="glyph">⌕</span>
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder="Search commands…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="results">
        {results.length === 0 ? (
          <div className="empty">No matches</div>
        ) : (
          results.map((r, i) => (
            <div
              key={r}
              className={`result ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => api.run(r)}
            >
              {r}
            </div>
          ))
        )}
      </div>
      <div className="hint">
        <span>↑↓ to navigate · ↵ to run · esc to dismiss</span>
        <span>mirin spotlight · ⌘⇧J</span>
      </div>
    </div>
  );
}
