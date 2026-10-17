/**
 * The outbound Discord send path: one REST POST per chunk of a reply.
 *
 * It lives apart from the Gateway client so each module has one
 * responsibility: this one knows Discord's message limit, its endpoint, its
 * `Bot` credential and its rate-limit answer; the client in
 * `messaging-discord-inbound.ts` knows the Gateway protocol. The client
 * re-exports these symbols, so callers and tests import one place.
 *
 * The boundary rule, the order of the chunks, the wait out of a 429 and the
 * bounded retry of a 5xx are the shared delivery loop's ([`deliverInChunks`]) —
 * the same loop every other channel's send path uses. What stays Discord's is
 * one request: the URL, the header, the body, and how a status maps onto the
 * shared outcome vocabulary.
 */

import {
  chunkIngressText,
  deliverInChunks,
  type IngressDeliveryResult,
  type IngressPostOutcome,
} from "./messaging-ingress.js";

/** Discord's per-message limit, in characters. */
export const DISCORD_MESSAGE_LIMIT = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host's fetch, injected so the send path is testable. */
export type DiscordFetch = typeof fetch;

/**
 * Split a reply at Discord's per-message limit, preserving order and content.
 *
 * The boundary rule — prefer a newline, then a space, then the exact limit, and
 * never split a surrogate pair — is the shared chunker's
 * ([`chunkIngressText`]); only the limit is Discord's. Joining the chunks
 * returns the original text exactly.
 */
export function chunkDiscordMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  return chunkIngressText(text, limit);
}

/** The shared result shape; a Discord send has nothing of its own to add. */
export type DiscordSendResult = IngressDeliveryResult;

/**
 * The outbound send path: the shared delivery loop over one Discord request.
 *
 * A 429 carries `retry_after` in seconds (the JSON body) or in milliseconds
 * (the `Retry-After` header, which Discord also sends); the shared loop waits
 * it out and retries the same chunk. A 5xx, and a transport failure, are
 * retried on the shared bounded schedule. Any other refusal ends the send with
 * a status-only detail: the response body and the token are never reported.
 */
export type DiscordSenderOptions = {
  token: string;
  /** The API base, e.g. `https://discord.com/api/v10`. */
  endpoint: string;
  /** How long one request may take. */
  requestTimeoutMs?: number;
  /** How the sender waits out a rate limit; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
  /** The fetch implementation; defaults to the runtime's global `fetch`. */
  fetchImpl?: DiscordFetch;
  /** The most attempts per chunk after a 429/5xx. */
  maxAttempts?: number;
};

export type DiscordSender = {
  send(channelId: string, text: string): Promise<DiscordSendResult>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/** A retry delay from a 429 body (`retry_after`, seconds) or the header (ms). */
function rateLimitDelayMs(body: unknown, header: string | null): number {
  if (isRecord(body) && typeof body.retry_after === "number" && body.retry_after >= 0) {
    return Math.ceil(body.retry_after * 1000);
  }
  const parsed = header !== null ? Number(header) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed * 1000) : 1000;
}

export function createDiscordSender(options: DiscordSenderOptions): DiscordSender {
  const token = options.token.trim();
  const base = options.endpoint.replace(/\/+$/, "");
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? fetch;

  /** One POST of one chunk, in the shared loop's outcome vocabulary. */
  const post = async (channel: string, chunk: string): Promise<IngressPostOutcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`${base}/channels/${encodeURIComponent(channel)}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }),
        signal: controller.signal,
        // A followed POST would carry the bot token to another host.
        redirect: "manual",
      });
      if (response.status === 429) {
        const retryAfterMs = rateLimitDelayMs(
          await response.json().catch(() => null),
          response.headers.get("retry-after"),
        );
        return { kind: "rate-limited", retryAfterMs };
      }
      if (response.status >= 500) return { kind: "unavailable" };
      if (response.status >= 300 && response.status < 400) {
        return { kind: "refused", error: `discord answered a redirect (HTTP ${response.status})` };
      }
      if (!response.ok) {
        return { kind: "refused", error: `discord answered HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      return { kind: "accepted", id: isRecord(body) && typeof body.id === "string" ? body.id : "" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async send(channelId: string, text: string): Promise<DiscordSendResult> {
      const channel = channelId.trim();
      if (!token) return { ok: false, error: "the configured bot token is empty", sent: 0 };
      if (!channel) return { ok: false, error: "the destination channel is empty", sent: 0 };
      return deliverInChunks(text, {
        platform: "discord",
        limit: DISCORD_MESSAGE_LIMIT,
        post: (chunk) => post(channel, chunk),
        maxAttempts,
        wait,
      });
    },
  };
}
