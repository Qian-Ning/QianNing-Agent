/**
 * Applies redaction and restore to a provider payload.
 *
 * Only string values are rewritten, never keys: a message key is part of the
 * request schema, and a provider that stops recognizing `content` or `text`
 * fails the whole turn. Structure is preserved exactly — this is a walk, not a
 * re-serialisation, so field order and types survive.
 *
 * Multimodal blobs are skipped (see `blob.ts`). An image arrives as
 * `{ type: "base64", data: "…" }` or under a `media_type`, and running a
 * phone-number regex over base64 would corrupt the payload for no security
 * gain.
 */

import { shouldSkipBlob } from "./blob.js";
import type { PlaceholderMatch } from "./placeholder.js";
import { findPlaceholders } from "./placeholder.js";
import type { RuleSet } from "./rules.js";
import type { MappingStore } from "./store.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Replaces every hit in one string.
 *
 * Right to left, so an earlier replacement never invalidates a later offset.
 */
export function redactText(text: string, rules: RuleSet, store: MappingStore): string {
  const hits = rules.findHits(text);
  if (hits.length === 0) return text;
  let output = text;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i] as (typeof hits)[number];
    // A stand-in has the same shape as the value it replaces, so the rules match
    // it again on the next turn. Redacting it would mint a second stand-in and
    // leave the first one unrestorable.
    if (store.isDisplay(hit.text)) continue;
    output = output.slice(0, hit.start) + store.getOrInsert(hit.type, hit.text) + output.slice(hit.end);
  }
  return output;
}

/** Replaces every token and stand-in this table issued; unknown text is left as written. */
export function restoreText(text: string, store: MappingStore): string {
  const found = findPlaceholders(text);
  let output = text;
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const match = found[i] as PlaceholderMatch;
    const plaintext = store.lookup(match.token);
    if (plaintext === undefined) continue;
    output = output.slice(0, match.start) + plaintext + output.slice(match.end);
  }
  return store.restoreDisplays(output);
}

function mapStrings(value: JsonValue, transform: (text: string) => string): JsonValue {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value !== null && typeof value === "object") {
    const binary = shouldSkipBlob(value);
    const output: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (binary && key === "data") {
        output[key] = child as JsonValue;
        continue;
      }
      output[key] = mapStrings(child as JsonValue, transform);
    }
    return output;
  }
  return value;
}

export function redactValue(value: unknown, rules: RuleSet, store: MappingStore): unknown {
  return mapStrings(value as JsonValue, (text) => redactText(text, rules, store));
}

export function restoreValue(value: unknown, store: MappingStore): unknown {
  return mapStrings(value as JsonValue, (text) => restoreText(text, store));
}

/** Parses a JSON string payload; undefined when the text is not JSON. */
export function parseJsonObject(text: string): JsonValue | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
