/**
 * A text's fingerprint, as the host's `selection` events carry it
 * (`textHash`): 32-bit FNV-1a over the UTF-16 code units, the host's
 * `events::text_hash`. It tells a driver which text a reported selection is
 * in, so one the field made before the driver replaced its text is known late.
 */
export function textHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
