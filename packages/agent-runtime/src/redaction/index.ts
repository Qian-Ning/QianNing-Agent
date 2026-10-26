/**
 * Outbound redaction, as a library.
 *
 * This module answers one question for the runtime: given a provider payload
 * about to leave the machine, which strings must be replaced before sending,
 * and how do the replacements come back in the reply? It owns no policy about
 * when to redact — that is the caller's switch — and it never talks to a
 * network. A caller assembles `RuleSet` + `MappingStore` and gets a `Redactor`
 * it can hang off the payload hook.
 *
 * Failure is deliberate: `redactPayload` throws rather than returning the
 * original payload when it cannot process one. A request that leaves with a
 * secret in it because a regex threw is worse than a request that fails and
 * tells the user why.
 */

import type { JsonValue } from "./walk.js";
import { parseJsonObject, redactText, redactValue, restoreText, restoreValue } from "./walk.js";
import { RestoreWindow } from "./restore-window.js";
import type { RuleSet } from "./rules.js";
import type { MappingStore } from "./store.js";

export * from "./blob.js";
export * from "./fake.js";
export * from "./install.js";
export * from "./notice.js";
export * from "./placeholder.js";
export * from "./restore-window.js";
export * from "./rules.js";
export * from "./store.js";
export * from "./stream.js";
export * from "./walk.js";

export interface RedactorOptions {
  rules: RuleSet;
  store: MappingStore;
}

export interface Redactor {
  /** Replaces hits in one string. */
  redactText(text: string): string;
  /** Replaces hits in a provider payload; a JSON string payload is parsed and walked. */
  redactPayload(payload: unknown): unknown;
  /** Puts the originals back in one string. */
  restoreText(text: string): string;
  /** Puts the originals back in a payload-shaped value. */
  restoreValue(value: unknown): unknown;
  /** A window for a streamed reply; one per stream. */
  createRestoreWindow(): RestoreWindow;
}

export function createRedactor(options: RedactorOptions): Redactor {
  const { rules, store } = options;
  return {
    redactText: (text) => redactText(text, rules, store),
    redactPayload(payload) {
      if (typeof payload === "string") {
        const parsed = parseJsonObject(payload);
        if (parsed === undefined) return redactText(payload, rules, store);
        return JSON.stringify(redactValue(parsed, rules, store));
      }
      if (payload !== null && typeof payload === "object") {
        return redactValue(payload as JsonValue, rules, store);
      }
      return payload;
    },
    restoreText: (text) => restoreText(text, store),
    restoreValue: (value) => restoreValue(value, store),
    createRestoreWindow: () => new RestoreWindow(store),
  };
}
