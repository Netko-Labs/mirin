/**
 * Produce a Windows `.ico` from the app's icon source (mirrors the macOS `.icns`
 * path in `bundle.ts`). mirin loads it at runtime and sets it as the window icon
 * (taskbar / Alt-Tab / title). Accepts a `.ico` (copied), a `.iconset` directory
 * (its `icon_NxN.png` renditions packed as multi-size PNG entries — Vista+ icons
 * embed PNGs directly, so no rescaling is needed), or a single `.png`.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The iconset renditions worth packing (small sizes render crisper than scaling 256). */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

interface IconEntry {
  size: number;
  png: Uint8Array;
}

/** Pack PNG renditions into a multi-image `.ico` (each entry is a PNG blob). */
function packIco(entries: IconEntry[]): Uint8Array {
  const headerSize = 6 + entries.length * 16;
  const header = new Uint8Array(headerSize);
  const dv = new DataView(header.buffer);
  dv.setUint16(0, 0, true); // reserved
  dv.setUint16(2, 1, true); // type 1 = icon
  dv.setUint16(4, entries.length, true);

  let offset = headerSize;
  entries.forEach((e, i) => {
    const base = 6 + i * 16;
    header[base] = e.size >= 256 ? 0 : e.size; // width (0 = 256)
    header[base + 1] = e.size >= 256 ? 0 : e.size; // height
    header[base + 2] = 0; // palette
    header[base + 3] = 0; // reserved
    dv.setUint16(base + 4, 1, true); // planes
    dv.setUint16(base + 6, 32, true); // bits per pixel
    dv.setUint32(base + 8, e.png.length, true); // bytes in resource
    dv.setUint32(base + 12, offset, true); // image offset
    offset += e.png.length;
  });

  const out = new Uint8Array(offset);
  out.set(header, 0);
  let pos = headerSize;
  for (const e of entries) {
    out.set(e.png, pos);
    pos += e.png.length;
  }
  return out;
}

/** Write `outPath` (an `.ico`) from `iconSrc`, returning it, or undefined if no
 *  usable source was found. */
export function makeWindowsIcon(iconSrc: string, outPath: string): string | undefined {
  if (!existsSync(iconSrc)) {
    console.warn(`[mirin] icon not found, skipping: ${iconSrc}`);
    return undefined;
  }
  if (iconSrc.endsWith(".ico")) {
    copyFileSync(iconSrc, outPath);
    return outPath;
  }

  const entries: IconEntry[] = [];
  if (iconSrc.endsWith(".iconset")) {
    for (const size of ICO_SIZES) {
      const png = join(iconSrc, `icon_${size}x${size}.png`);
      if (existsSync(png)) entries.push({ size, png: readFileSync(png) });
    }
  } else if (iconSrc.endsWith(".png")) {
    entries.push({ size: 256, png: readFileSync(iconSrc) });
  }

  if (!entries.length) {
    console.warn(`[mirin] no usable icon renditions in ${iconSrc}`);
    return undefined;
  }
  writeFileSync(outPath, packIco(entries));
  return outPath;
}
