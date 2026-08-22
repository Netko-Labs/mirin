/** Brand tokens for the explainer components. Mirrors src/styles/app.css. */
export const INK = "#14100c";
export const RICE = "#f7f4ec";
export const AMBER = "#dd9a3f";
export const AMBER_SOFT = "#ecbe7a";
export const PANEL = "#0f0c09";

export const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" } as const;
export const serif = { fontFamily: "'Instrument Serif', Georgia, serif" } as const;

export const rice = (alpha: number) => `rgba(247,244,236,${alpha})`;
export const amber = (alpha: number) => `rgba(221,154,63,${alpha})`;

export const shell: React.CSSProperties = {
  background: INK,
  color: RICE,
  fontFamily: "'Space Grotesk', system-ui, sans-serif",
  borderRadius: 16,
  border: `1px solid ${rice(0.12)}`,
  padding: 28,
};
