/**
 * What each field's native buffer holds, as far as the driver can tell: the
 * text it last reported (`change`), or the value the app last set in its
 * place. A field's text has two writers, the person typing in the host and
 * the app setting `value`, and what each sends says which text it was made
 * on, by its hash (`lib/text-hash.ts`):
 *
 * - the field reports its selection with the hash of the text it is in
 *   (`textHash`), and a change with the hash of the text it was typed on
 *   (`baseHash`). One made in a text the app has since replaced (typed
 *   "1250", the app wrote it "1,250"; typed "*" as the keypad wrote "7") is
 *   known late and never reaches the app, which would take it for an edit
 *   of its own value;
 * - a value the app sets goes out with the hash of the text it replaces
 *   (`baseHash` on the node, to a host that takes it), so the host tells
 *   its own text coming back from an app's write, and carries what was
 *   typed meanwhile onto a write: it reports that as a change made on the
 *   app's value, which is the one that reaches the app;
 * - a selection the app sets goes out with the hash of the text it was made
 *   in (`textHash` on it, to a host that takes it): what the field held as
 *   far as the driver knew, the new value when the app wrote one with it.
 *   A field that holds another text by then (keys the app had not heard of)
 *   does not take it: the caret stays with what was typed.
 */

import type { TextSelection } from "../types.ts";
import { textHash } from "./text-hash.ts";

interface FieldText {
  /** What the buffer holds. */
  text: string;
  /** Its hash, worked out when first asked. */
  hash: number | null;
  /** The app's value and revision in the last tree. */
  value: string;
  revision: number | undefined;
  /** What `value` went out with: the hash of the text it was set over. */
  base: number | undefined;
  /** The app's selection in the last tree, and the hash of the text it was made in. */
  selection: { start: number; end: number; madeIn: number } | undefined;
}

export class FieldTexts {
  private readonly byId = new Map<string, FieldText>();

  /** A tree went out with only these fields: the others left. */
  keep(ids: ReadonlySet<string>): void {
    for (const id of this.byId.keys()) if (!ids.has(id)) this.byId.delete(id);
  }

  /**
   * A field goes out with this value and revision: a value the app set (not
   * one the field typed) replaces the buffer, as a new revision does (the
   * app wrote its value again: it refused what the field typed). Answers
   * the hash of the text the value was set over, for a host that takes it
   * (`stamps`): the same for as long as the value and the revision stay.
   */
  field(
    id: string,
    value: string,
    revision: number | undefined,
    stamps: boolean,
  ): number | undefined {
    const known = this.byId.get(id);
    if (!known) {
      this.byId.set(id, {
        text: value,
        hash: null,
        value,
        revision,
        base: undefined,
        selection: undefined,
      });
      return undefined;
    }
    if (known.value === value && known.revision === revision) return known.base;
    if (stamps) {
      known.hash ??= textHash(known.text);
      known.base = known.hash;
    } else known.base = undefined;
    if (known.revision !== revision || known.text !== value) {
      known.text = value;
      known.hash = null;
    }
    known.value = value;
    known.revision = revision;
    return known.base;
  }

  /**
   * A field goes out with this `selection` (after `field` took its value):
   * answers the hash of the text the app made it in, which is what the
   * field holds as far as the driver knows. The same for as long as the
   * selection stays: only a new one is the app's news.
   */
  selected(id: string, selection: TextSelection | undefined): number | undefined {
    const known = this.byId.get(id);
    if (!known || !selection) {
      if (known) known.selection = undefined;
      return undefined;
    }
    const { start, end } = selection;
    if (known.selection?.start !== start || known.selection.end !== end) {
      known.hash ??= textHash(known.text);
      known.selection = { start, end, madeIn: known.hash };
    }
    return known.selection.madeIn;
  }

  /** The field left the tree. */
  forget(id: string): void {
    this.byId.delete(id);
  }

  /**
   * The field reported its text, typed on the text hashing to `base` and
   * itself hashing to `hash` (a host from before them says neither). False
   * when it was typed on a text the app has since replaced: the field does
   * not hold it for long, and the app must not hear it.
   */
  typed(id: string, text: string, base?: number, hash?: number): boolean {
    const known = this.byId.get(id);
    if (!known) return true;
    if (base !== undefined) {
      known.hash ??= textHash(known.text);
      if (known.hash !== base) return false;
    }
    if (known.text !== text) {
      known.text = text;
      known.hash = hash ?? null;
    }
    return true;
  }

  /** Whether a selection reported in the text hashing to `hash` is in what the field holds (yes when the host didn't say). */
  holds(id: string, hash: number | undefined): boolean {
    const known = this.byId.get(id);
    if (hash === undefined || !known) return true;
    known.hash ??= textHash(known.text);
    return known.hash === hash;
  }
}
