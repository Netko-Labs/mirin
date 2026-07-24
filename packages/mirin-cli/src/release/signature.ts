import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

const MAX_KEY_BYTES = 1024;
const ED25519_SIGNATURE_BYTES = 64;

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

/** Sign exact manifest bytes and prove the private key matches the packaged public key. */
export function signUpdateManifest(manifest: Uint8Array, publicKey: string): string {
  const privateKey = matchingPrivateKey(publicKey);
  return sign(null, manifest, privateKey).toString("base64");
}

/** Fail before release work starts when signing credentials are absent or mismatched. */
export function assertUpdateSigningKey(publicKey: string): void {
  matchingPrivateKey(publicKey);
}

/** Verify exact manifest bytes when reading a previous release for delta creation. */
export function verifyUpdateManifest(
  manifest: Uint8Array,
  signature: string,
  publicKey: string,
): void {
  const signatureBytes = strictBase64(
    signature.trim(),
    ED25519_SIGNATURE_BYTES,
    "update manifest signature",
  );
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error("invalid update manifest signature");
  }
  const key = createPublicKey({
    key: Buffer.from(validateUpdatePublicKey(publicKey), "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, manifest, key, signatureBytes)) {
    throw new Error("update manifest signature verification failed");
  }
}

function updatePrivateKey(): KeyObject {
  const value = process.env.MIRIN_UPDATE_PRIVATE_KEY;
  if (!value) {
    throw new Error(
      "[mirin release] MIRIN_UPDATE_PRIVATE_KEY is required to sign update manifests.",
    );
  }
  try {
    const key = value.startsWith("-----BEGIN")
      ? createPrivateKey(value)
      : createPrivateKey({
          key: strictBase64(value, MAX_KEY_BYTES, "update private key"),
          format: "der",
          type: "pkcs8",
        });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error(
      "[mirin release] MIRIN_UPDATE_PRIVATE_KEY must be an Ed25519 PEM or base64 DER PKCS8 key.",
    );
  }
}

function matchingPrivateKey(publicKey: string): KeyObject {
  const privateKey = updatePrivateKey();
  const expectedPublic = Buffer.from(validateUpdatePublicKey(publicKey), "base64");
  const actualPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (
    actualPublic.length !== expectedPublic.length ||
    !timingSafeEqual(actualPublic, expectedPublic)
  ) {
    throw new Error("[mirin release] MIRIN_UPDATE_PRIVATE_KEY does not match release.publicKey.");
  }
  return privateKey;
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
