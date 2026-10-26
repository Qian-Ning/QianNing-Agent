/**
 * Placeholder tokens used in place of a secret between the outbound request and
 * the reply.
 *
 * The grammar is deliberately narrow — an uppercase type of 1..=32 characters,
 * an underscore, then a 26-character Crockford base32 ULID inside double
 * braces. Anything that does not parse is left alone, which is what keeps
 * ordinary mustache templates (`{{TODO_1}}`, `{{ user.name }}`) untouched.
 *
 * A model reads these as opaque identifiers, so they must survive a round trip
 * through a provider: no spaces, no punctuation a template engine would rewrite,
 * and a fixed width the streaming restorer can recognise one character at a time.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A parsed token: the type decides which rule produced it. */
export interface Placeholder {
  type: string;
  id: string;
}

/**
 * A fresh regex, never a shared module-level literal.
 *
 * A `/g` regex carries `lastIndex` between calls; one re-entrant scan would
 * silently skip matches. Every caller gets its own instance.
 */
export function placeholderPattern(): RegExp {
  return /\{\{([A-Z][A-Z0-9]{0,31})_([0-9A-HJKMNP-TV-Z]{26})\}\}/g;
}

/** 48-bit millisecond timestamp followed by 80 bits of randomness, Crockford encoded. */
export function newPlaceholderId(now = Date.now(), random: () => number = Math.random): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  let noise = "";
  for (let i = 0; i < 16; i += 1) noise += CROCKFORD[Math.floor(random() * 32) % 32];
  return time + noise;
}

export function formatPlaceholder(placeholder: Placeholder): string {
  return `{{${placeholder.type}_${placeholder.id}}}`;
}

/** Parses one complete token; a partial or padded string does not match. */
export function parsePlaceholder(token: string): Placeholder | undefined {
  const match = placeholderPattern().exec(token);
  if (!match || match[0] !== token) return undefined;
  return { type: match[1] as string, id: match[2] as string };
}

export interface PlaceholderMatch {
  start: number;
  end: number;
  token: string;
  placeholder: Placeholder;
}

export function findPlaceholders(text: string): PlaceholderMatch[] {
  const found: PlaceholderMatch[] = [];
  const pattern = placeholderPattern();
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const placeholder = parsePlaceholder(match[0]);
    if (placeholder) {
      found.push({ start: match.index, end: match.index + match[0].length, token: match[0], placeholder });
    }
  }
  return found;
}
