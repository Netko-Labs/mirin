/**
 * Produce a Windows `.ico` from the app's icon source (mirrors the macOS `.icns`
 * path in `bundle.ts`). Emits **classic DIB/BMP icon entries** (32bpp BGRA + AND
 * mask), NOT PNG-compressed entries: Bun's `--windows-icon` embedder silently
 * ignores PNG-format ICOs (the exe keeps Bun's default icon), and some shells
 * mis-scale them. Accepts a `.ico` (copied), a `.iconset` directory (its
 * `icon_NxN.png` renditions), or a single square `.png`.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/** Standard Windows icon sizes; intermediate sizes are downscaled from these by
 *  the shell, so the 256 entry keeps large views crisp. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

interface IcoEntry {
  size: number;
  /** DIB image (small sizes) or raw PNG bytes (256) — see {@link rendition}. */
  data: Buffer;
  /** True when `data` is a PNG blob (the 256 convention) rather than a DIB. */
  png: boolean;
}

/**
 * Minimal PNG decoder → top-down RGBA. Handles 8-bit, non-interlaced, color
 * types 0/2/4/6 (the renditions macOS `iconutil`/`sips` and design tools emit).
 * Throws on anything else so the caller skips just that rendition.
 */
function decodePng(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
  }
  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]!;
    const cur = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    unfilter(filter, cur, prev, channels);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (channels === 4) {
        r = cur[s]!;
        g = cur[s + 1]!;
        b = cur[s + 2]!;
        a = cur[s + 3]!;
      } else if (channels === 3) {
        r = cur[s]!;
        g = cur[s + 1]!;
        b = cur[s + 2]!;
        a = 255;
      } else if (channels === 2) {
        r = g = b = cur[s]!;
        a = cur[s + 1]!;
      } else {
        r = g = b = cur[s]!;
        a = 255;
      }
      const d = (y * width + x) * 4;
      rgba[d] = r;
      rgba[d + 1] = g;
      rgba[d + 2] = b;
      rgba[d + 3] = a;
    }
    prev = cur;
  }
  return { width, height, rgba };
}

/** Reverse a PNG scanline filter in place (None/Sub/Up/Average/Paeth). */
function unfilter(filter: number, cur: Buffer, prev: Buffer, bpp: number): void {
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    let v = cur[i]!;
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[i] = v & 0xff;
  }
}

/** Encode one icon image as a DIB: BITMAPINFOHEADER + bottom-up 32bpp BGRA + a
 *  (zeroed) 1bpp AND mask — the alpha channel drives transparency. */
function dibEntry(size: number, rgba: Buffer): Buffer {
  const xor = Buffer.alloc(size * size * 4);
  for (let dy = 0; dy < size; dy++) {
    const sy = size - 1 - dy; // DIB rows run bottom-to-top
    for (let x = 0; x < size; x++) {
      const s = (sy * size + x) * 4;
      const d = (dy * size + x) * 4;
      xor[d] = rgba[s + 2]!; // B
      xor[d + 1] = rgba[s + 1]!; // G
      xor[d + 2] = rgba[s]!; // R
      xor[d + 3] = rgba[s + 3]!; // A
    }
  }
  const andStride = Math.ceil(size / 32) * 4; // 1bpp, rows padded to 4 bytes
  const andMask = Buffer.alloc(andStride * size, 0);
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0); // biSize
  hdr.writeInt32LE(size, 4); // biWidth
  hdr.writeInt32LE(size * 2, 8); // biHeight = XOR rows + AND rows
  hdr.writeUInt16LE(1, 12); // biPlanes
  hdr.writeUInt16LE(32, 14); // biBitCount
  hdr.writeUInt32LE(0, 16); // BI_RGB
  hdr.writeUInt32LE(xor.length + andMask.length, 20);
  return Buffer.concat([hdr, xor, andMask]);
}

/** Assemble the ICONDIR + entries into a `.ico`. */
function packIco(entries: IcoEntry[]): Buffer {
  const dirSize = 6 + entries.length * 16;
  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type 1 = icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dirSize;
  entries.forEach((e, i) => {
    const base = 6 + i * 16;
    dir[base] = e.size >= 256 ? 0 : e.size; // width (0 = 256)
    dir[base + 1] = e.size >= 256 ? 0 : e.size; // height
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, base + 8); // bytes in resource
    dir.writeUInt32LE(offset, base + 12); // image offset
    offset += e.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

/**
 * Build one icon entry from a square PNG rendition. Sizes ≥256 are stored as the
 * raw PNG blob (the Windows convention — a 256×256 DIB is non-standard and is
 * rejected by Bun/rcedit/the resource compiler); smaller sizes are decoded to a
 * DIB. Returns undefined if the file isn't the expected square size.
 */
function rendition(file: string, size: number): IcoEntry | undefined {
  try {
    const buf = readFileSync(file);
    if (size >= 256) return { size, data: buf, png: true };
    const { width, height, rgba } = decodePng(buf);
    if (width !== size || height !== size) return undefined;
    return { size, data: dibEntry(size, rgba), png: false };
  } catch (e) {
    console.warn(`[mirin] icon: skipping ${file} (${e instanceof Error ? e.message : e})`);
    return undefined;
  }
}

/**
 * Write `outPath` (an `.ico`) from `iconSrc`, returning it, or undefined if no
 * usable source was found. With `onlyLargest`, emits a single (largest) entry —
 * needed for the **exe** icon, since rcedit's multi-size icon replacement fails on
 * Bun-compiled exes (single-entry works, and Windows downscales 256 cleanly for
 * small views). The full multi-size form is fine for `icon.ico` (NSIS + WM_SETICON).
 */
export function makeWindowsIcon(
  iconSrc: string,
  outPath: string,
  opts?: { onlyLargest?: boolean },
): string | undefined {
  if (!existsSync(iconSrc)) {
    console.warn(`[mirin] icon not found, skipping: ${iconSrc}`);
    return undefined;
  }
  if (iconSrc.endsWith(".ico")) {
    copyFileSync(iconSrc, outPath);
    return outPath;
  }

  const entries: IcoEntry[] = [];
  if (iconSrc.endsWith(".iconset")) {
    const sizes = opts?.onlyLargest ? [...ICO_SIZES].reverse() : ICO_SIZES;
    for (const size of sizes) {
      const png = join(iconSrc, `icon_${size}x${size}.png`);
      if (existsSync(png)) {
        const e = rendition(png, size);
        if (e) {
          entries.push(e);
          if (opts?.onlyLargest) break;
        }
      }
    }
  } else if (iconSrc.endsWith(".png")) {
    try {
      const buf = readFileSync(iconSrc);
      const { width, height, rgba } = decodePng(buf);
      if (width !== height || width > 256) {
        console.warn(`[mirin] icon png must be square ≤256px (got ${width}×${height})`);
      } else if (width === 256) {
        entries.push({ size: 256, data: buf, png: true });
      } else {
        entries.push({ size: width, data: dibEntry(width, rgba), png: false });
      }
    } catch (e) {
      console.warn(
        `[mirin] icon: cannot decode ${iconSrc} (${e instanceof Error ? e.message : e})`,
      );
    }
  }

  if (!entries.length) {
    console.warn(`[mirin] no usable icon renditions in ${iconSrc}`);
    return undefined;
  }
  writeFileSync(outPath, packIco(entries));
  return outPath;
}
