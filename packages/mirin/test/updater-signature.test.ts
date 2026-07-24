import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { parseUpdatePublicKey, verifyManifestSignature } from "../src/updater/lib/signature.ts";

describe("updater manifest signatures", () => {
  test("verifies exact manifest bytes with the embedded Ed25519 key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const encodedPublic = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const manifest = new TextEncoder().encode('{"version":"1.2.3"}\n');
    const signature = sign(null, manifest, privateKey).toString("base64");

    expect(parseUpdatePublicKey(encodedPublic)).toBe(encodedPublic);
    expect(() => verifyManifestSignature(manifest, signature, encodedPublic)).not.toThrow();
    expect(() =>
      verifyManifestSignature(
        new TextEncoder().encode('{"version":"1.2.4"}\n'),
        signature,
        encodedPublic,
      ),
    ).toThrow("signature verification failed");
  });

  test("rejects non-Ed25519 keys and malformed signatures", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const encodedPublic = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => parseUpdatePublicKey(encodedPublic)).toThrow("publicKey");
    expect(() =>
      verifyManifestSignature(
        new Uint8Array(),
        "not-base64",
        "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
      ),
    ).toThrow("signature");
  });
});
