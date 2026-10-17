/**
 * The outbound Discord send path: one REST POST per chunk of a reply.
 *
 * It lives apart from the Gateway client so each module has one
 * responsibility: this one knows Discord's message limit, the chunk boundary
 * rule, and the platform's rate-limit answer; the client in
 * `messaging-discord-inbound.ts` knows the Gateway protocol. The client
 * re-exports these symbols, so callers and tests import one place.
 */

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
 * A split prefers the last newline inside the window, then the last space, and
 * otherwise falls exactly at the limit. A cut never separates a surrogate pair,
 * so a message containing an emoji is not corrupted at the boundary. Joining
 * the chunks returns the original text exactly: the separator stays at the end
 * of the earlier chunk.
 */
export function chunkDiscordMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  const size = Math.max(1, Math.floor(limit));
  if (text.length <= size) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size - 1);
    if (cut <= 0) cut = rest.lastIndexOf(" ", size - 1);
    if (cut <= 0) cut = size;
    // Never split a surrogate pair: step back one unit when the cut lands
    // between a high and a low surrogate.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export type DiscordSendResult =
  | { ok: true; sent: number; ids: string[] }
  | { ok: false; error: string; sent: number };

/**
 * The outbound send path: one POST per chunk, sequentially, so a long reply
 * arrives in the order it was written.
 *
 * A 429 carries `retry_after` in seconds (the JSON body) or in milliseconds
 * (the `Retry-After` header, which Discord also sends); the wait is honoured up
 * to a bounded number of attempts per chunk. A 5xx is retried on the same
 * bounded schedule. Any other refusal ends the send with a status-only detail:
 * the response body and the token are never reported.
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

  return {
    async send(channelId: string, text: string): Promise<DiscordSendResult> {
      const channel = channelId.trim();
      if (!token) return { ok: false, error: "the configured bot token is empty", sent: 0 };
      if (!channel) return { ok: false, error: "the destination channel is empty", sent: 0 };
      const chunks = chunkDiscordMessage(text);
      if (chunks.length === 0) return { ok: true, sent: 0, ids: [] };
      const ids: string[] = [];
      for (const chunk of chunks) {
        let sent = false;
        for (let attempt = 0; attempt < maxAttempts && !sent; attempt += 1) {
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
              const retryAfter = rateLimitDelayMs(
                await response.json().catch(() => null),
                response.headers.get("retry-after"),
              );
              await wait(retryAfter);
              continue;
            }
            if (response.status >= 500) {
              await wait(Math.min(30_000, 500 * 2 ** attempt));
              continue;
            }
            if (response.status >= 300 && response.status < 400) {
              return { ok: false, error: `discord answered a redirect (HTTP ${response.status})`, sent: ids.length };
            }
            if (!response.ok) {
              return { ok: false, error: `discord answered HTTP ${response.status}`, sent: ids.length };
            }
            const body = (await response.json().catch(() => null)) as unknown;
            ids.push(isRecord(body) && typeof body.id === "string" ? body.id : "");
            sent = true;
          } catch (error) {
            // The message is deliberately not the platform's answer: it names
            // the failure class only, so a transport detail cannot echo a
            // credential.
            if (attempt + 1 >= maxAttempts) {
              return {
                ok: false,
                error: error instanceof Error && error.name === "AbortError"
                  ? "the send timed out"
                  : "the send failed",
                sent: ids.length,
              };
            }
            await wait(Math.min(30_000, 500 * 2 ** attempt));
          } finally {
            clearTimeout(timer);
          }
        }
        if (!sent) return { ok: false, error: "discord kept rate limiting the send", sent: ids.length };
      }
      return { ok: true, sent: ids.length, ids };
    },
  };
}

