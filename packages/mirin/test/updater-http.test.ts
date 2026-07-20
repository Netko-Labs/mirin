import { describe, expect, test } from "bun:test";
import { readBoundedManifestJson } from "../src/updater/lib/http.ts";

describe("bounded updater manifest responses", () => {
  test("accepts chunked JSON within the response limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"version":"1.'));
          controller.enqueue(new TextEncoder().encode('2.3"}'));
          controller.close();
        },
      }),
    );
    await expect(readBoundedManifestJson(response)).resolves.toEqual({ version: "1.2.3" });
  });

  test("rejects declared and streamed manifest bodies above the limit", async () => {
    await expect(
      readBoundedManifestJson(
        new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }),
      ),
    ).rejects.toThrow("update manifest exceeds");

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
    );
    await expect(readBoundedManifestJson(response)).rejects.toThrow("update manifest exceeds");
  });
});
