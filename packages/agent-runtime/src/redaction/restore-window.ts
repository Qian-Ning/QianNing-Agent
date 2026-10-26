/**
 * Restores stand-ins and placeholders in a streamed reply.
 *
 * Two shapes have to survive being split across chunks. A placeholder
 * (`{{PHONE_01J…}}`) is held from its opening brace until it parses or is proven
 * not to be one. A stand-in is a bare value with no syntax at all — its only
 * tell is that the buffer ends with a proper prefix of a value this table
 * issued — so it is held at the longest such prefix.
 *
 * Holding is bounded: a stream that never emits a brace and never ends on a
 * stand-in prefix is never delayed, and a pathological run is released after
 * `MAX_HOLD` characters, which is longer than any token this module issues.
 *
 * Without this, a restored phone number would occasionally arrive as
 * `{{PHONE_01J…` followed by `…AB}}`, or as `1390000` followed by `1111`.
 */

import { findPlaceholders } from "./placeholder.js";
import type { MappingStore } from "./store.js";

/** A token is at most 63 characters; 96 leaves room for a stray prefix. */
const MAX_HOLD = 96;

const TYPE_PREFIX = /^[A-Z][A-Z0-9]{0,31}$/;
const ID_PREFIX = /^[0-9A-HJKMNP-TV-Z]{0,26}$/;

/**
 * Whether `text` could still grow into a complete token.
 *
 * Written as a character-class check rather than a truncated regex because the
 * input is, by definition, incomplete: a regex requiring the closing `}}` would
 * reject every prefix it is meant to recognise.
 */
export function isPlaceholderPrefix(text: string): boolean {
  if (text.length > MAX_HOLD) return false;
  if (!text.startsWith("{")) return false;
  if (text.length === 1) return true;
  if (text[1] !== "{") return false;
  const rest = text.slice(2);
  if (rest.length === 0) return true;
  if (rest.startsWith("}")) return false;
  const underscore = rest.indexOf("_");
  if (underscore === -1) return TYPE_PREFIX.test(rest);
  const type = rest.slice(0, underscore);
  if (!TYPE_PREFIX.test(type) || type.length === 0) return false;
  let id = rest.slice(underscore + 1);
  if (id.endsWith("}")) id = id.slice(0, -1);
  else if (id.includes("}")) return false;
  return ID_PREFIX.test(id);
}

/** Index where a suffix that may still become a token starts. */
function braceHoldStart(text: string): number {
  let brace = text.lastIndexOf("{");
  while (brace !== -1) {
    // The token opens with "{{"; `lastIndexOf` lands on the second brace of a
    // partial token, so step back one when the character before it is also one.
    const start = brace > 0 && text[brace - 1] === "{" ? brace - 1 : brace;
    if (isPlaceholderPrefix(text.slice(start))) return start;
    brace = brace > 0 ? text.lastIndexOf("{", brace - 1) : -1;
  }
  return text.length;
}

export class RestoreWindow {
  private tail = "";

  constructor(private readonly store: MappingStore) {}

  /** Feeds one streamed chunk and returns what is safe to display now. */
  push(chunk: string): string {
    if (chunk.length === 0) return "";
    this.tail += chunk;
    return this.emit(false);
  }

  /** Releases everything held back. Call at end of stream. */
  flush(): string {
    return this.emit(true);
  }

  private emit(flush: boolean): string {
    const buffer = this.tail;
    this.tail = "";
    if (flush) return this.render(buffer);

    const hold = Math.min(braceHoldStart(buffer), this.displayHoldStart(buffer));
    const safe = buffer.slice(0, hold);
    const keep = buffer.slice(hold);
    // Past the bound and still nothing plausible: release rather than stall.
    if (keep.length > MAX_HOLD && braceHoldStart(keep) === keep.length && this.displayHoldStart(keep) === keep.length) {
      return this.render(buffer);
    }
    this.tail = keep;
    return this.render(safe);
  }

  /** Where the longest trailing prefix of an issued stand-in begins. */
  private displayHoldStart(text: string): number {
    const values = this.store.displayValues();
    if (values.length === 0 || text.length === 0) return text.length;
    let best = text.length;
    for (const value of values) {
      // A complete value in the buffer is restorable, so stop at length - 1.
      const limit = Math.min(value.length - 1, text.length);
      for (let length = limit; length >= 1; length -= 1) {
        if (!text.endsWith(value.slice(0, length))) continue;
        const start = text.length - length;
        if (start < best) best = start;
        break;
      }
    }
    return best;
  }

  /** Replaces every complete token and stand-in in `text`. */
  private render(text: string): string {
    if (text.length === 0) return "";
    let output = "";
    let last = 0;
    for (const match of findPlaceholders(text)) {
      output += text.slice(last, match.start);
      const plaintext = this.store.lookup(match.token);
      output += plaintext === undefined ? match.token : plaintext;
      last = match.end;
    }
    output += text.slice(last);
    return this.store.restoreDisplays(output);
  }
}
