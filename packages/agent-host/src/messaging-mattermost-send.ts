/**
 * The outbound Mattermost send path: one REST POST per chunk of a reply, with
 * `root_id` carrying the thread.
 *
 * It lives apart from the websocket client so each module has one
 * responsibility; the client re-exports these symbols, so callers and tests
 * import one place.
 */

import { validateInboundEndpoint } from "./messaging-inbound.js";

/** Mattermost's default `MaxPostSize`, in characters. */
export const MATTERMOST_POST_LIMIT = 16_383;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/** The host's fetch, injected so the send path is testable. */
export type MattermostFetch = typeof fetch;

/**
 * Split a reply at Mattermost's post limit, preserving order and content.
 *
 * The same rule as the Discord chunker: prefer a newline, then a space, then
 * the exact limit; never split a surrogate pair; joining the chunks returns the
 * original text exactly.
 */
export function chunkMattermostPost(text: string, limit: number = MATTERMOST_POST_LIMIT): string[] {
  const size = Math.max(1, Math.floor(limit));
  if (text.length <= size) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size - 1);
    if (cut <= 0) cut = rest.lastIndexOf(" ", size - 1);
    if (cut <= 0) cut = size;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export type MattermostSendTarget = {
  /** The channel the reply belongs in. */
  channelId: string;
  /** The thread root, when the inbound post was in a thread. */
  rootId?: string;
};

export type MattermostSendResult =
  | { ok: true; sent: number; ids: string[] }
  | { ok: false; error: string; sent: number };

export type MattermostSenderOptions = {
  /** The base URL the user configured, e.g. `https://chat.example.com`. */
  endpoint: string;
  token: string;
  requestTimeoutMs?: number;
  /** How the sender waits out a rate limit; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: MattermostFetch;
  /** The network policy's answer: is a plaintext hop to the LAN allowed? */
  allowInsecureHttp?: boolean;
  maxAttempts?: number;
};

export type MattermostSender = {
  send(target: MattermostSendTarget, text: string): Promise<MattermostSendResult>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * The outbound send path: one POST per chunk to `/api/v4/posts`, sequentially.
 *
 * Every chunk of one reply carries the same `root_id`, so a long answer stays
 * in one thread rather than splitting across the channel. A 429 is waited out
 * from `Retry-After` (seconds), a 5xx is retried on a bounded backoff, and any
 * other refusal ends the send with a status-only detail; the token never
 * appears in a result.
 */
export function createMattermostSender(options: MattermostSenderOptions): MattermostSender {
  const token = options.token.trim();
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send(target: MattermostSendTarget, text: string): Promise<MattermostSendResult> {
      const channelId = target.channelId.trim();
      if (!token) return { ok: false, error: "the configured access token is empty", sent: 0 };
      if (!channelId) return { ok: false, error: "the destination channel is empty", sent: 0 };
      const checked = validateInboundEndpoint(options.endpoint, {
        allowInsecureHttp: options.allowInsecureHttp,
      });
      if (!checked.ok) return { ok: false, error: checked.error, sent: 0 };
      const base = `${checked.url.protocol}//${checked.url.host}${checked.url.pathname.replace(/\/+$/, "")}`;
      const chunks = chunkMattermostPost(text);
      if (chunks.length === 0) return { ok: true, sent: 0, ids: [] };
      const ids: string[] = [];
      for (const chunk of chunks) {
        let sent = false;
        for (let attempt = 0; attempt < maxAttempts && !sent; attempt += 1) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await fetchImpl(`${base}/api/v4/posts`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                channel_id: channelId,
                message: chunk,
                ...(target.rootId && target.rootId.trim() ? { root_id: target.rootId.trim() } : {}),
              }),
              signal: controller.signal,
              // A followed POST would carry the bearer token to another host.
              redirect: "manual",
            });
            if (response.status === 429) {
              const header = response.headers.get("retry-after");
              const parsed = header !== null ? Number(header) : NaN;
              await wait(Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed * 1000) : 1000);
              continue;
            }
            if (response.status >= 500) {
              await wait(Math.min(30_000, 500 * 2 ** attempt));
              continue;
            }
            if (response.status >= 300 && response.status < 400) {
              return { ok: false, error: `mattermost answered a redirect (HTTP ${response.status})`, sent: ids.length };
            }
            if (!response.ok) {
              return { ok: false, error: `mattermost answered HTTP ${response.status}`, sent: ids.length };
            }
            const body = (await response.json().catch(() => null)) as unknown;
            ids.push(isRecord(body) && typeof body.id === "string" ? body.id : "");
            sent = true;
          } catch (error) {
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
        if (!sent) return { ok: false, error: "mattermost kept rate limiting the send", sent: ids.length };
      }
      return { ok: true, sent: ids.length, ids };
    },
  };
}

