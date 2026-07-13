/**
 * Release-time Ed25519 signing of the update manifest.
 *
 * When `MIRIN_UPDATE_PRIVATE_KEY` (raw 32-byte Ed25519 seed, base64) is present,
 * `mirin release` writes a detached `{prefix}-update.json.sig` next to the
 * manifest. The app verifies it against the `release.publicKey` pinned at build
 * time (see packages/mirin/src/updater/lib/signature.ts). Without the env var the
 * manifest is published unsigned and a warning is logged.
 */

import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { join } from "node:path";

// The invariant DER prefix for a raw Ed25519 private seed (PKCS8).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privateKeyFromRawBase64(base64: string): ReturnType<typeof createPrivateKey> {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) {
    throw new Error("MIRIN_UPDATE_PRIVATE_KEY must be a base64 32-byte Ed25519 seed");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

/** Base64 detached Ed25519 signature over `data`. */
export function signManifest(data: Uint8Array, privateKeyBase64: string): string {
  return nodeSign(null, data, privateKeyFromRawBase64(privateKeyBase64)).toString("base64");
}

/**
 * Write `{manifestName}.sig` when a signing key is configured. Returns the
 * signature file name, or null when publishing unsigned.
 */
export async function signManifestIfConfigured(
  outDir: string,
  manifestName: string,
  manifestBody: string,
): Promise<string | null> {
  const privateKey = process.env.MIRIN_UPDATE_PRIVATE_KEY;
  if (!privateKey) {
    console.warn(
      "[mirin release] MIRIN_UPDATE_PRIVATE_KEY not set — manifest is UNSIGNED. " +
        "Apps with a pinned `release.publicKey` will reject this update.",
    );
    return null;
  }
  const signature = signManifest(new TextEncoder().encode(manifestBody), privateKey);
  const sigName = `${manifestName}.sig`;
  await Bun.write(join(outDir, sigName), `${signature}\n`);
  return sigName;
}
