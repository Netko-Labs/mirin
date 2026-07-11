#!/usr/bin/env bun

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const libraryPath = Bun.argv[2];
if (!libraryPath) {
  throw new Error("usage: bun scripts/smoke-notification.ts <native-library>");
}

const library = dlopen(libraryPath, {
  mirin_notification_show: { args: [FFIType.ptr], returns: FFIType.i32 },
});

try {
  const payload = Buffer.from(
    `${JSON.stringify({ title: "Mirin release smoke", body: `Native ${suffix} notification bridge` })}\0`,
  );
  const result = library.symbols.mirin_notification_show(ptr(payload));
  if (result !== 0 && result !== 1) {
    throw new Error(`notification bridge returned invalid status ${result}`);
  }
  console.log(`notification bridge smoke passed (accepted=${result === 1})`);
} finally {
  library.close();
}
