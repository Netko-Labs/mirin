import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  assertUpdateSigningKey,
  signUpdateManifest,
  validateUpdatePublicKey,
  verifyUpdateManifest,
} from "../src/release/signature.ts";

const originalPrivateKey = process.env.MIRIN_UPDATE_PRIVATE_KEY;

afterEach(() => {
  if (originalPrivateKey === undefined) delete process.env.MIRIN_UPDATE_PRIVATE_KEY;
  else process.env.MIRIN_UPDATE_PRIVATE_KEY = originalPrivateKey;
});

describe("release manifest signatures", () => {
  test("signs exact bytes only with the private key matching the packaged public key", () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    process.env.MIRIN_UPDATE_PRIVATE_KEY = pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const manifest = new TextEncoder().encode('{"version":"1.2.3"}\n');

    expect(validateUpdatePublicKey(publicKey)).toBe(publicKey);
    expect(() => assertUpdateSigningKey(publicKey)).not.toThrow();
    const signature = signUpdateManifest(manifest, publicKey);
    expect(() => verifyUpdateManifest(manifest, signature, publicKey)).not.toThrow();
    expect(() =>
      verifyUpdateManifest(new TextEncoder().encode('{"version":"1.2.4"}\n'), signature, publicKey),
    ).toThrow("verification failed");
  });

  test("rejects a mismatched private key", () => {
    const expected = generateKeyPairSync("ed25519");
    const actual = generateKeyPairSync("ed25519");
    process.env.MIRIN_UPDATE_PRIVATE_KEY = actual.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const publicKey = expected.publicKey.export({ format: "der", type: "spki" }).toString("base64");

    expect(() => assertUpdateSigningKey(publicKey)).toThrow("does not match");
  });
});
