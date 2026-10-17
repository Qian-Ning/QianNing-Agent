/**
 * The outbound Mattermost send path: one REST POST per chunk of a reply, with
 * `root_id` carrying the thread.
 *
 * It lives apart from the websocket client so each module has one
 * responsibility; the client re-exports these symbols, so callers and tests
 * import one place.
 *
 * The boundary rule, the order of the chunks, the wait out of a 429 and the
 * bounded retry of a 5xx are the shared delivery loop's ([`deliverInChunks`]).
 * What stays Mattermost's is one request: the endpoint rule, the URL, the
 * bearer header, the body (with `root_id`), and how a status maps onto the
 * shared outcome vocabulary.
 */

import {
  chunkIngressText,
  deliverInChunks,
  type IngressDeliveryResult,
  type IngressPostOutcome,
} from "./messaging-ingress.js";
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
  return chunkIngressText(text, limit);
}

export type MattermostSendTarget = {
  /** The channel the reply belongs in. */
  channelId: string;
  /** The thread root, when the inbound post was in a thread. */
  rootId?: string;
};

/** The shared result shape; a Mattermost send has nothing of its own to add. */
export type MattermostSendResult = IngressDeliveryResult;

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
 * The outbound send path: the shared delivery loop over one `/api/v4/posts`
 * request per chunk.
 *
 * Every chunk of one reply carries the same `root_id`, so a long answer stays
 * in one thread rather than splitting across the channel. A 429 is waited out
 * from `Retry-After` (seconds) by the shared loop, a 5xx is retried on the
 * shared bounded backoff, and any other refusal ends the send with a
 * status-only detail; the token never appears in a result.
 */
export function createMattermostSender(options: MattermostSenderOptions): MattermostSender {
  const token = options.token.trim();
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? fetch;

  /** One POST of one chunk, in the shared loop's outcome vocabulary. */
  const post = async (
    base: string,
    channelId: string,
    rootId: string,
    chunk: string,
  ): Promise<IngressPostOutcome> => {
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
          ...(rootId ? { root_id: rootId } : {}),
        }),
        signal: controller.signal,
        // A followed POST would carry the bearer token to another host.
        redirect: "manual",
      });
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const parsed = header !== null ? Number(header) : NaN;
        return {
          kind: "rate-limited",
          retryAfterMs: Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed * 1000) : 1000,
        };
      }
      if (response.status >= 500) return { kind: "unavailable" };
      if (response.status >= 300 && response.status < 400) {
        return { kind: "refused", error: `mattermost answered a redirect (HTTP ${response.status})` };
      }
      if (!response.ok) {
        return { kind: "refused", error: `mattermost answered HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      return { kind: "accepted", id: isRecord(body) && typeof body.id === "string" ? body.id : "" };
    } finally {
      clearTimeout(timer);
    }
  };

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
      const rootId = target.rootId?.trim() ?? "";
      return deliverInChunks(text, {
        platform: "mattermost",
        limit: MATTERMOST_POST_LIMIT,
        post: (chunk) => post(base, channelId, rootId, chunk),
        maxAttempts,
        wait,
      });
    },
  };
}
