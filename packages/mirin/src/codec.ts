/**
 * mirin/codec — thin bun:ffi bindings to libmirin_core's updater codec (zstd +
 * bsdiff, file-path API). Used both at `mirin release` time (produce patches)
 * and at runtime (apply them), loading the same dylib so compress/diff are
 * byte-identical on both sides.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

const SYMBOLS = {
  mirin_zstd_compress_file: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mirin_zstd_decompress_file: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mirin_bsdiff_file: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mirin_bspatch_file: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;

function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(s + "\0");
}

export interface Codec {
  /** zstd-compress `src` → `dst` at `level` (default 19). */
  compress(src: string, dst: string, level?: number): void;
  /** zstd-decompress `src` → `dst`. */
  decompress(src: string, dst: string): void;
  /** bsdiff: write a patch turning `oldPath` into `newPath`. */
  diff(oldPath: string, newPath: string, patchPath: string): void;
  /** bspatch: apply `patchPath` to `oldPath`, producing `newPath`. */
  patch(oldPath: string, patchPath: string, newPath: string): void;
}

/** Load the codec from a libmirin_core dylib path. */
export function loadCodec(dylibPath: string): Codec {
  const { symbols } = dlopen(dylibPath, SYMBOLS);
  const check = (rc: number, op: string) => {
    if (rc !== 0) throw new Error(`codec ${op} failed (rc=${rc})`);
  };
  return {
    compress(src, dst, level = 19) {
      const s = cstr(src);
      const d = cstr(dst);
      check(symbols.mirin_zstd_compress_file(ptr(s), ptr(d), level), "compress");
    },
    decompress(src, dst) {
      const s = cstr(src);
      const d = cstr(dst);
      check(symbols.mirin_zstd_decompress_file(ptr(s), ptr(d)), "decompress");
    },
    diff(oldPath, newPath, patchPath) {
      const o = cstr(oldPath);
      const n = cstr(newPath);
      const p = cstr(patchPath);
      check(symbols.mirin_bsdiff_file(ptr(o), ptr(n), ptr(p)), "diff");
    },
    patch(oldPath, patchPath, newPath) {
      const o = cstr(oldPath);
      const p = cstr(patchPath);
      const n = cstr(newPath);
      check(symbols.mirin_bspatch_file(ptr(o), ptr(p), ptr(n)), "patch");
    },
  };
}
