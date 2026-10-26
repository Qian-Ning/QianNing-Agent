/**
 * Restores placeholders in a streamed reply.
 *
 * A token can be split across two chunks — `{{PHONE_01J…` in one and `…AB}}` in
 * the next — so the tail of every chunk is held back until it is provably not
 * the start of a token. Holding is bounded: a stream that never emits `{` is
 * never delayed, and even a pathological run of braces is released after
 * `MAX_HOLD` characters, which is longer than any token this module issues.
 *
 * Without this, a restored phone number would occasionally arrive as
 * `{{PHONE_01J…` followed by `…AB}}`, and no later stage can repair that.
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
function holdStart(text: string): number {
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
    let output = "";
    let last = 0;
    for (const match of findPlaceholders(buffer)) {
      output += buffer.slice(last, match.start);
      const plaintext = this.store.lookup(match.token);
      output += plaintext === undefined ? match.token : plaintext;
      last = match.end;
    }
    const remaining = buffer.slice(last);
    if (flush) return output + remaining;
    const start = holdStart(remaining);
    output += remaining.slice(0, start);
    const keep = remaining.slice(start);
    // Past the bound and still not a token start: release it rather than stall.
    if (keep.length > MAX_HOLD && !keep.startsWith("{{")) return output + keep;
    this.tail = keep;
    return output;
  }
}
