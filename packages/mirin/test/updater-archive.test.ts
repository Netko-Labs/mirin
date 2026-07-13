import { describe, expect, test } from "bun:test";
import { unsafeArchiveEntry } from "../src/updater/lib/archive.ts";
import { isLoopbackUpdateUrl } from "../src/updater/lib/urls.ts";

describe("archive entry classification", () => {
  test("allows regular files and directories", () => {
    expect(unsafeArchiveEntry("-rw-r--r-- 0 user group 12 Jan 1 00:00 App/file")).toBeNull();
    expect(unsafeArchiveEntry("drwxr-xr-x 0 user group 0 Jan 1 00:00 App/dir/")).toBeNull();
  });

  test("allows a relative in-bundle symlink (macOS frameworks use these)", () => {
    expect(
      unsafeArchiveEntry("lrwxr-xr-x 0 user group 0 Jan 1 00:00 App/Versions/Current -> A"),
    ).toBeNull();
    expect(
      unsafeArchiveEntry(
        "lrwxr-xr-x 0 user group 0 Jan 1 00:00 App/Resources -> Versions/Current/Resources",
      ),
    ).toBeNull();
  });

  test("rejects a symlink whose target escapes the bundle", () => {
    expect(unsafeArchiveEntry("lrwxr-xr-x 0 u g 0 Jan 1 00:00 App/evil -> /etc")).not.toBeNull();
    expect(
      unsafeArchiveEntry("lrwxr-xr-x 0 u g 0 Jan 1 00:00 App/evil -> ../../../etc"),
    ).not.toBeNull();
    expect(
      unsafeArchiveEntry("lrwxrwxrwx u/g 0 2024-01-01 00:00 App/evil -> C:\\Windows"),
    ).not.toBeNull();
  });

  test("rejects device / fifo / socket nodes", () => {
    expect(
      unsafeArchiveEntry("crw-rw-rw- 0 root root 1,3 Jan 1 00:00 App/dev/null"),
    ).not.toBeNull();
    expect(unsafeArchiveEntry("prw-r--r-- 0 u g 0 Jan 1 00:00 App/pipe")).not.toBeNull();
  });

  test("ignores blank lines", () => {
    expect(unsafeArchiveEntry("")).toBeNull();
  });
});

describe("loopback update url gate", () => {
  test("recognizes loopback hosts only", () => {
    expect(isLoopbackUpdateUrl("http://localhost:4000")).toBe(true);
    expect(isLoopbackUpdateUrl("http://127.0.0.1:4000/x")).toBe(true);
    expect(isLoopbackUpdateUrl("https://example.com")).toBe(false);
    expect(isLoopbackUpdateUrl("not a url")).toBe(false);
  });
});
