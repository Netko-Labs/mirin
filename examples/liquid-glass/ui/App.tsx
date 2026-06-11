import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { WindowMaterial, WindowMaterialOptions } from "mirinjs/config";

type Material = WindowMaterial | WindowMaterialOptions | null;

interface Choice {
  key: string;
  label: string;
  note: string;
  value: Material;
}

/** Materials to cycle through, grouped for the picker. */
const CHOICES: Choice[] = [
  { key: "glass", label: "Liquid Glass", note: "NSGlassEffectView", value: { type: "liquidGlass", cornerRadius: 20 } },
  { key: "glass-blue", label: "Glass · blue tint", note: "tint #3b82f6", value: { type: "liquidGlass", tint: "#3b82f6aa", cornerRadius: 20 } },
  { key: "glass-pink", label: "Glass · pink tint", note: "tint #ec4899", value: { type: "liquidGlass", tint: "#ec4899aa", cornerRadius: 20 } },
  { key: "hud", label: "HUD", note: "vibrancy", value: { type: "hud", cornerRadius: 20 } },
  { key: "sidebar", label: "Sidebar", note: "vibrancy", value: { type: "sidebar", cornerRadius: 20 } },
  { key: "popover", label: "Popover", note: "vibrancy", value: { type: "popover", cornerRadius: 20 } },
  { key: "menu", label: "Menu", note: "vibrancy", value: { type: "menu", cornerRadius: 20 } },
  { key: "underWindow", label: "Under Window", note: "vibrancy", value: { type: "underWindowBackground", cornerRadius: 20 } },
  { key: "fullScreen", label: "Full Screen UI", note: "vibrancy", value: { type: "fullScreenUI", cornerRadius: 20 } },
  { key: "none", label: "None", note: "clear (no material)", value: null },
];

export function App() {
  const [active, setActive] = useState("glass");

  // Reflect whatever the main process currently has applied.
  useEffect(() => {
    api.current(null).then((m) => {
      const found = CHOICES.find((c) => sameKind(c.value, m));
      if (found) setActive(found.key);
    });
  }, []);

  function pick(c: Choice) {
    setActive(c.key);
    api.setMaterial(c.value);
  }

  return (
    <div className="app">
      <header>
        <h1>Liquid Glass</h1>
        <p>Native macOS materials rendered behind a transparent (OSR) web window. Click to swap live.</p>
      </header>
      <div className="grid">
        {CHOICES.map((c) => (
          <button
            key={c.key}
            className={`card ${active === c.key ? "active" : ""}`}
            onClick={() => pick(c)}
          >
            <span className="label">{c.label}</span>
            <span className="note">{c.note}</span>
          </button>
        ))}
      </div>
      <footer>
        Liquid Glass needs macOS 26+. On older systems it falls back to a frosted vibrancy material.
      </footer>
    </div>
  );
}

function sameKind(a: Material, b: Material): boolean {
  const kind = (m: Material) => (m == null ? "none" : typeof m === "string" ? m : m.type);
  return kind(a) === kind(b);
}
