/**
 * Installs outbound redaction on a model registry.
 *
 * Order matters, and it is the opposite of what it looks like: hosted search
 * wraps `streamSimple` and calls the previous `onPayload` *before* it replays
 * search blocks into the body. Installing redaction first puts it inside that
 * chain, so the body it rewrites is the final one — replay included — rather
 * than the caller's payload with the replayed blocks appended afterwards.
 *
 * The failure mode is deliberate: if the payload cannot be redacted, the request
 * is not sent. A body that might still carry a secret never leaves the machine.
 */
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { RuleSet, builtinRules } from "./rules.js";
import type { MappingStore } from "./store.js";
import { restoreStream } from "./stream.js";
import { redactValue } from "./walk.js";
import { withPlaceholderNotice } from "./notice.js";

export interface RedactionBinding {
  store: MappingStore;
  /** Defaults to the built-in rule table. */
  rules?: RuleSet;
  /** Observes a redaction failure; the request fails either way. */
  onFailure?: (error: unknown) => void;
}

export function installRedaction(models: Models, binding: RedactionBinding): void {
  const rules = binding.rules ?? new RuleSet({ rules: builtinRules() });
  const store = binding.store;
  const streamSimple = models.streamSimple.bind(models);

  models.streamSimple = ((model: Model<Api>, context: unknown, options: Record<string, unknown> = {}) => {
    const previousPayload = options.onPayload as
      | ((payload: unknown, payloadModel: Model<Api>) => unknown | Promise<unknown>)
      | undefined;

    const stream = streamSimple(model, context as never, {
      ...options,
      onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
        const base = previousPayload ? ((await previousPayload(payload, payloadModel)) ?? payload) : payload;
        try {
          return withPlaceholderNotice(redactValue(base, rules, store));
        } catch (error) {
          binding.onFailure?.(error);
          throw error;
        }
      },
    } as never);

    return restoreStream(stream, store);
  }) as typeof models.streamSimple;
}
