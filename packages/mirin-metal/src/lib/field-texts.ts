/**
 * What each field's native buffer holds, as far as the driver can tell: the
 * text it last reported (`change`), or the value the app last set in its
 * place. The field reports its selection with the hash of the text it is in
 * (`textHash`), so a selection made in a text the app has since replaced
 * (typed "1250", the app wrote it "1,250") is known late and never reaches
 * the app, which would put those offsets into its own value. Only fields
 * with `onSelectionChange` are followed.
 */

import { textHash } from "./text-hash.ts";

interface FieldText {
  /** What the buffer holds. */
  text: string;
  /** Its hash, worked out when first asked. */
  hash: number | null;
  /** The app's value and revision in the last tree. */
  value: string;
  revision: number | undefined;
}

export class FieldTexts {
  private readonly byId = new Map<string, FieldText>();

  /** A tree went out with these fields: a value the app set (not one the field typed) replaces the buffer, as a new revision does. */
  follow(fields: ReadonlyMap<string, { value: string; revision: number | undefined }>): void {
    for (const id of this.byId.keys()) if (!fields.has(id)) this.byId.delete(id);
    for (const [id, { value, revision }] of fields) this.field(id, value, revision);
  }

  /** One field went out with this value and revision (a patch), as `follow` takes each. */
  field(id: string, value: string, revision: number | undefined): void {
    const known = this.byId.get(id);
    if (!known) {
      this.byId.set(id, { text: value, hash: null, value, revision });
      return;
    }
    if (known.value === value && known.revision === revision) return;
    if (known.revision !== revision || known.text !== value) {
      known.text = value;
      known.hash = null;
    }
    known.value = value;
    known.revision = revision;
  }

  /** The field left the tree, or stopped following its selection. */
  forget(id: string): void {
    this.byId.delete(id);
  }

  /** The field reported its text. */
  typed(id: string, text: string): void {
    const known = this.byId.get(id);
    if (!known || known.text === text) return;
    known.text = text;
    known.hash = null;
  }

  /** Whether a selection reported in the text hashing to `hash` is in what the field holds (yes when the host didn't say). */
  holds(id: string, hash: number | undefined): boolean {
    const known = this.byId.get(id);
    if (hash === undefined || !known) return true;
    known.hash ??= textHash(known.text);
    return known.hash === hash;
  }
}
