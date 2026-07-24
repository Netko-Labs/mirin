import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * mirin/codec — thin bun:ffi bindings to libmirin_core's updater codec (zstd +
 * bsdiff, file-path API). Trusted local callers may use the legacy unbounded
 * operations; updater paths should use the explicitly bounded variants.
 */

const SYMBOLS = {
  mirin_zstd_compress_file: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mirin_zstd_decompress_file: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mirin_zstd_decompress_file_bounded: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  mirin_bsdiff_file: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mirin_bspatch_file: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  mirin_bspatch_file_bounded: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
} as const;

function cstr(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

function byteLimit(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

export interface Codec {
  /** zstd-compress `src` → `dst` at `level` (default 19). */
  compress(src: string, dst: string, level?: number): void;
  /** zstd-decompress `src` → `dst` for trusted local input. */
  decompress(src: string, dst: string): void;
  /** zstd-decompress with an enforced maximum output size. */
  decompressBounded(src: string, dst: string, maxOutputBytes: number): void;
  /** bsdiff: write a patch turning `oldPath` into `newPath`. */
  diff(oldPath: string, newPath: string, patchPath: string): void;
  /** bspatch trusted local input, producing `newPath`. */
  patch(oldPath: string, patchPath: string, newPath: string): void;
  /** bspatch with enforced input and output size limits. */
  patchBounded(
    oldPath: string,
    patchPath: string,
    newPath: string,
    maxOldBytes: number,
    maxPatchBytes: number,
    maxOutputBytes: number,
  ): void;
}

/** Load the codec from a libmirin_core dylib path. */
export function loadCodec(dylibPath: string): Codec {
  const { symbols } = dlopen(dylibPath, SYMBOLS);
  const check = (rc: number, operation: string): void => {
    if (rc !== 0) throw new Error(`codec ${operation} failed (rc=${rc})`);
  };
  return {
    compress(src, dst, level = 19) {
      const source = cstr(src);
      const destination = cstr(dst);
      check(symbols.mirin_zstd_compress_file(ptr(source), ptr(destination), level), "compress");
    },
    decompress(src, dst) {
      const source = cstr(src);
      const destination = cstr(dst);
      check(symbols.mirin_zstd_decompress_file(ptr(source), ptr(destination)), "decompress");
    },
    decompressBounded(src, dst, maxOutputBytes) {
      const source = cstr(src);
      const destination = cstr(dst);
      check(
        symbols.mirin_zstd_decompress_file_bounded(
          ptr(source),
          ptr(destination),
          byteLimit(maxOutputBytes, "maxOutputBytes"),
        ),
        "bounded decompress",
      );
    },
    diff(oldPath, newPath, patchPath) {
      const old = cstr(oldPath);
      const next = cstr(newPath);
      const patch = cstr(patchPath);
      check(symbols.mirin_bsdiff_file(ptr(old), ptr(next), ptr(patch)), "diff");
    },
    patch(oldPath, patchPath, newPath) {
      const old = cstr(oldPath);
      const patch = cstr(patchPath);
      const next = cstr(newPath);
      check(symbols.mirin_bspatch_file(ptr(old), ptr(patch), ptr(next)), "patch");
    },
    patchBounded(oldPath, patchPath, newPath, maxOldBytes, maxPatchBytes, maxOutputBytes) {
      const old = cstr(oldPath);
      const patch = cstr(patchPath);
      const next = cstr(newPath);
      check(
        symbols.mirin_bspatch_file_bounded(
          ptr(old),
          ptr(patch),
          ptr(next),
          byteLimit(maxOldBytes, "maxOldBytes"),
          byteLimit(maxPatchBytes, "maxPatchBytes"),
          byteLimit(maxOutputBytes, "maxOutputBytes"),
        ),
        "bounded patch",
      );
    },
  };
}
