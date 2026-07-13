import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { verifyManifestSignature } from "../src/updater/lib/signature.ts";

/** A fresh Ed25519 keypair as the raw base64 values mirin embeds/exports. */
function rawKeypair(): { publicKey: string; privateKey: import("node:crypto").KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: Buffer.from(rawPublic).toString("base64"), privateKey };
}

const manifest = new TextEncoder().encode('{"version":"1.2.3"}\n');

describe("update manifest signature", () => {
  test("accepts a valid detached signature", () => {
    const { publicKey, privateKey } = rawKeypair();
    const signature = nodeSign(null, manifest, privateKey).toString("base64");
    expect(verifyManifestSignature(manifest, signature, publicKey)).toBe(true);
  });

  test("rejects a tampered manifest", () => {
    const { publicKey, privateKey } = rawKeypair();
    const signature = nodeSign(null, manifest, privateKey).toString("base64");
    const tampered = new TextEncoder().encode('{"version":"9.9.9"}\n');
    expect(verifyManifestSignature(tampered, signature, publicKey)).toBe(false);
  });

  test("rejects a signature from a different key", () => {
    const signer = rawKeypair();
    const other = rawKeypair();
    const signature = nodeSign(null, manifest, signer.privateKey).toString("base64");
    expect(verifyManifestSignature(manifest, signature, other.publicKey)).toBe(false);
  });

  test("rejects malformed key / signature without throwing", () => {
    const { publicKey, privateKey } = rawKeypair();
    const signature = nodeSign(null, manifest, privateKey).toString("base64");
    expect(verifyManifestSignature(manifest, signature, "not-base64-key")).toBe(false);
    expect(verifyManifestSignature(manifest, "", publicKey)).toBe(false);
    expect(verifyManifestSignature(manifest, "AAAA", publicKey)).toBe(false);
  });
});
