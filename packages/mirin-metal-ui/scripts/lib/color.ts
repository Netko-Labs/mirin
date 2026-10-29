/** Color conversion shared by the generator scripts. */

/** oklch(L C H [/ A]) → #rrggbb[aa]. Math from CSS Color 4. */
export function oklchToHex(value: string): string | undefined {
  const m = value.match(
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/,
  );
  if (!m) return undefined;
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const c = Number(m[3]);
  // A `none` hue (achromatic colors) is 0.
  const h = m[4] === "none" ? 0 : (Number(m[4]) * Math.PI) / 180;
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const linear = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const channel = (x: number) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  const hex = `#${linear.map(channel).join("")}`;
  return alpha >= 1
    ? hex
    : `${hex}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, "0")}`;
}
