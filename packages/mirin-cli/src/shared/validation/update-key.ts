import { createPublicKey, type KeyObject } from "node:crypto";

const MAX_KEY_BYTES = 1024;

/** Validate and normalize a base64 DER Ed25519 SubjectPublicKeyInfo value. */
export function validateUpdatePublicKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error(
      "[mirin] release.publicKey or MIRIN_UPDATE_PUBLIC_KEY must contain a base64 DER Ed25519 public key.",
    );
  }
  const der = strictBase64(value, MAX_KEY_BYTES, "update public key");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("[mirin] update public key is not valid DER SubjectPublicKeyInfo.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("[mirin] update public key must use Ed25519.");
  }
  return der.toString("base64");
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
