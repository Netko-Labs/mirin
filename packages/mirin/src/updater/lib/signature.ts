/**
 * Ed25519 verification of the update manifest's authenticity.
 *
 * The manifest's SHA-256 fields only prove the download matches numbers the
 * manifest itself chose — they say nothing about *who* published it. When the
 * app is configured with a release `publicKey`, the updater additionally
 * verifies a detached signature over the exact manifest bytes with that pinned
 * key, so only the holder of the private key can ship an update.
 *
 * Keys are raw 32-byte Ed25519 values, base64-encoded, wrapped into the fixed
 * SPKI/PKCS8 DER envelopes here so users only ever handle a short base64 string.
 */

import { createPublicKey, verify as nodeVerify } from "node:crypto";

// The invariant DER prefixes for a raw Ed25519 public key (SubjectPublicKeyInfo).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromRawBase64(base64: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) throw new Error("invalid Ed25519 public key (expected 32 raw bytes)");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify a detached Ed25519 `signature` (base64) over `data` using the raw
 * base64 `publicKey`. Returns false on any malformed input — never throws — so
 * a bad key or garbage signature is a clean rejection, not a crash.
 */
export function verifyManifestSignature(
  data: Uint8Array,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) return false;
    return nodeVerify(null, data, publicKeyFromRawBase64(publicKeyBase64), signature);
  } catch {
    return false;
  }
}
