/**
 * Instructions the main thread retires, from the CPU's own counter
 * (`perf_event_open`, Linux, user space only). A shared machine stretches
 * wall time two- or threefold between runs of the same work; the count of
 * instructions barely moves, so two builds of the driver compare by it
 * where their times would only show the noise. Null where the counter
 * can't be opened (another OS, `perf_event_paranoid` above 2, a VM
 * without a PMU).
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

const PERF_EVENT_OPEN = 298; // x86_64
const PERF_TYPE_HARDWARE = 0;
const PERF_COUNT_HW_INSTRUCTIONS = 1;
/** `perf_event_attr` as its first version laid it out (64 bytes). */
const ATTR_SIZE = 64;
const EXCLUDE_KERNEL = 1n << 5n;
const EXCLUDE_HV = 1n << 6n;

export interface InstructionCounter {
  /** Instructions retired by the calling thread since it was opened. */
  read(): number;
}

export function openInstructionCounter(): InstructionCounter | null {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  try {
    const libc = dlopen("libc.so.6", {
      syscall: {
        args: [FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
        returns: FFIType.i64,
      },
      read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    });
    const attr = new DataView(new ArrayBuffer(ATTR_SIZE));
    attr.setUint32(0, PERF_TYPE_HARDWARE, true);
    attr.setUint32(4, ATTR_SIZE, true);
    attr.setBigUint64(8, BigInt(PERF_COUNT_HW_INSTRUCTIONS), true);
    attr.setBigUint64(40, EXCLUDE_KERNEL | EXCLUDE_HV, true);
    // This thread (pid 0), on any CPU (-1), in no group (-1).
    const fd = Number(libc.symbols.syscall(PERF_EVENT_OPEN, ptr(attr), 0, -1, -1, 0));
    if (fd < 0) return null;
    const value = new BigUint64Array(1);
    const at = ptr(value);
    return {
      read() {
        libc.symbols.read(fd, at, 8);
        return Number(value[0]);
      },
    };
  } catch {
    return null;
  }
}
