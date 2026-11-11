/**
 * Raft as an outbound channel.
 *
 * This is the one channel whose send path does not go through host-core's
 * delivery ledger (ADR `raft-in-typescript`): the service publishes no HTTP
 * contract for posting a message, so the only supported way is the SDK, and the
 * SDK is TypeScript.
 *
 * What survives from the ledger is idempotency: the delivery id travels as the
 * SDK's `idempotencyKey`, so a retry cannot produce a second message. What does
 * not survive is the attempt record — a send that never reaches Raft leaves no
 * row behind, and the caller has to keep that failure itself.
 */

export type RaftSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: string; retryable: boolean };

/** The parts of the SDK the sender uses. Structural, so a fake can stand in. */
export type RaftSendClient = {
  channels: {
    join(request: { target: string }): Promise<{ ok: boolean; error?: { message?: string } }>;
  };
  messages: {
    send(request: {
      target: string;
      content: string;
      idempotencyKey: string;
    }): Promise<
      | { ok: true; data?: { id?: string | null } }
      | { ok: false; error?: { message?: string; reason?: string } }
    >;
  };
};

export type RaftSender = {
  send(input: { target: string; text: string; idempotencyKey: string }): Promise<RaftSendResult>;
  /** Join a public channel so a send there is allowed. Idempotent. */
  join(target: string): Promise<RaftSendResult>;
};

/**
 * A sender over one credential.
 *
 * Nothing is cached: `joined` remembers which targets this process has already
 * joined, so a send to a public channel costs one join for the process rather
 * than one per message.
 */
export function createRaftSender(client: RaftSendClient): RaftSender {
  const joined = new Set<string>();

  async function join(target: string): Promise<RaftSendResult> {
    if (joined.has(target)) return { ok: true, messageId: null };
    try {
      const result = await client.channels.join({ target });
      if (!result.ok) {
        return {
          ok: false,
          reason: result.error?.message ?? "the channel join was refused",
          // A refused join is a permission or visibility problem, not a hiccup.
          retryable: false,
        };
      }
      joined.add(target);
      return { ok: true, messageId: null };
    } catch (error) {
      return { ok: false, reason: String(error), retryable: true };
    }
  }

  return {
    join,
    async send({ target, text, idempotencyKey }) {
      try {
        const result = await client.messages.send({ target, content: text, idempotencyKey });
        if (result.ok) {
          return { ok: true, messageId: result.data?.id ?? null };
        }
        const reason = result.error?.message ?? "the send was refused";
        return {
          ok: false,
          reason,
          // The SDK reports a held send (unseen messages in the conversation) as
          // a refusal the caller resolves by reading; retrying the identical
          // request would be held again, so it is not retryable here.
          retryable: false,
        };
      } catch (error) {
        // A transport failure is worth another attempt with the same key.
        return { ok: false, reason: String(error), retryable: true };
      }
    },
  };
}
