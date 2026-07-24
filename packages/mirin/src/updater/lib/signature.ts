import { createPublicKey, verify } from "node:crypto";

const MAX_KEY_BYTES = 1024;
const ED25519_SIGNATURE_BYTES = 64;

/** Validate and normalize the Ed25519 trust root embedded in version.json. */
export function parseUpdatePublicKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("invalid installed version field: publicKey");
  }
  try {
    const der = strictBase64(value, MAX_KEY_BYTES, "installed update public key");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return der.toString("base64");
  } catch {
    throw new Error("invalid installed version field: publicKey");
  }
}

/** Verify the detached signature over the exact manifest response bytes. */
export function verifyManifestSignature(
  manifest: Uint8Array,
  encodedSignature: string,
  encodedPublicKey: string,
): void {
  const signature = strictBase64(
    encodedSignature.trim(),
    ED25519_SIGNATURE_BYTES,
    "update manifest signature",
  );
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error("invalid update manifest signature");
  }
  const key = createPublicKey({
    key: Buffer.from(parseUpdatePublicKey(encodedPublicKey), "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, manifest, key, signature)) {
    throw new Error("update manifest signature verification failed");
  }
}

function strictBase64(value: string, maximumBytes: number, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new Error(`invalid ${label}`);
  }
  return bytes;
}
